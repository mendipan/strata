import { el, pill, fields } from "./dom.js";
import { agentClient, defaultAgentLimits } from "./agent-setup.js";
function supportedExpected(expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const keys = Object.keys(expected);
  return expected.kind === "absent" ? keys.length === 1
    : expected.kind === "value" ? keys.length === 2 && Object.hasOwn(expected, "value")
    : expected.kind === "fingerprint" ? keys.length === 2 && typeof expected.fingerprint === "string" && expected.fingerprint.length === 64
    : false;
}
function expectedPreview(expected) {
  if (!supportedExpected(expected)) return "Unsupported expected value";
  if (expected.kind === "absent") return "Item absent";
  if (expected.kind === "fingerprint") return "Fingerprint: " + expected.fingerprint;
  return typeof expected.value === "string" ? expected.value : JSON.stringify(expected.value);
}
export async function agentWorkspace(ctx) {
  const root = el("div", { class: "page agent-workspace" }),
    pane = el("div"),
    notice = el("p", {
      role: "status",
      "aria-live": "polite",
      class: "notice",
    });
  if (!ctx.owner) {
    root.append(
      el("h1", {}, "Agent"),
      el("p", {}, "Sign in as the installation owner to use agents."),
    );
    return root;
  }
  let status = await ctx.agentRequest("connections"),
    client = agentClient(ctx, status),
    selected =
      status.connections.find((c) => c.enabled && !c.revoked)?.id ?? "",
    conversation = null,
    history = [],
    archived = false,
    expired = false,
    busy = false,
    timer = null,
    draftText = "";
  const baseline = ctx.state.at || ctx.releases[0]?.ref,
    turnSaved = new Set(),
    draftIds = new Map();
  function watch() {
    clearTimeout(timer);
    if (
      ctx.signal?.aborted ||
      expired ||
      busy ||
      client.pending ||
      !conversation ||
      !root.isConnected
    )
      return;
    const unfinished = history.find(
      (t) =>
        ["queued", "running", "cancel_requested"].includes(t.state) &&
        Date.parse(t.deadline) > Date.now(),
    );
    if (!unfinished) return;
    const id = conversation.id;
    timer = setTimeout(async () => {
      try {
        const observed = await ctx.agentRequest("conversations/" + id);
        ctx.check();
        if (conversation?.id !== id) return;
        conversation = observed.conversation;
        history = observed.turns;
        archived = observed.archived;
        paint();
      } catch (e) {
        if (["OWNER_SESSION_REQUIRED", "SESSION_REQUIRED"].includes(e.code)) {
          expired = true;
          paint();
          notice.textContent = e.message;
          notice.append(
            el(
              "button",
              { onclick: () => location.reload() },
              "Refresh sign-in",
            ),
          );
          notice.tabIndex = -1;
          notice.focus();
          notice.scrollIntoView({ block: "center" });
          return;
        }
        if (e.name !== "AbortError")
          notice.textContent =
            "Progress lookup stopped. Use Refresh conversation to inspect this original turn.";
      }
    }, 2000);
  }
  ctx.signal?.addEventListener("abort", () => clearTimeout(timer), {
    once: true,
  });
  async function run(body) {
    if (busy) return;
    busy = true;
    paint();
    try {
      const result = await client.action(body);
      ctx.check();
      if (body.action === "conversation") conversation = result;
      if (body.action === "turn" && result?.request) {
        history.push(result);
        draftText = "";
      }
      if (body.action === "inspect") {
        conversation = result.conversation;
        history = result.turns;
        archived = result.archived;
      }
      notice.textContent =
        body.action === "save"
          ? "Draft saved. Open Changes or Review to inspect its immutable revision."
          : body.action === "turn"
            ? "Message submitted once. Refresh this conversation to inspect its progress."
            : body.action === "consent"
              ? "Project context consent saved. Start a conversation."
              : "Agent action confirmed.";
      if (body.action === "save") {
        turnSaved.add(body.turn_id);
        ctx.agentSaved?.(result?.draft_result);
        const ref =
          result?.draft_result?.data?.ref ?? result?.draft_result?.ref;
        if (ref)
          notice.append(
            el(
              "a",
              {
                href:
                  ctx.href?.("review", { ref, type: "layer" }) ??
                  "#/review?ref=" + encodeURIComponent(ref),
              },
              "Open saved draft",
            ),
          );
      }
      if (body.action === "inspect-save" && result?.draft_result) {
        turnSaved.add(result.turn_id);
        await client.inspect();
        notice.textContent =
          "Original owner draft confirmed. No save was replayed.";
      }
      return result;
    } catch (e) {
      notice.textContent = e.message;
      if (["OWNER_SESSION_REQUIRED", "SESSION_REQUIRED"].includes(e.code)) {
        expired = true;
        notice.append(
          el("button", { onclick: () => location.reload() }, "Refresh sign-in"),
        );
      }
      if (e.code === "OWNER_REAUTH_REQUIRED" && ctx.reauth)
        notice.append(
          el(
            "button",
            {
              onclick: async () => {
                await ctx.reauth();
                status = await ctx.agentRequest("connections");
                client = agentClient(ctx, status);
                paint();
              },
            },
            "Confirm password",
          ),
        );
    } finally {
      busy = false;
      paint();
      if (expired) {
        notice.tabIndex = -1;
        notice.focus();
        notice.scrollIntoView({ block: "center" });
      }
    }
  }
  function paint() {
    const disabled =
      expired ||
      busy ||
      !!client.pending ||
      archived ||
      history.some((t) =>
        ["queued", "running", "cancel_requested", "interrupted"].includes(
          t.state,
        ),
      );
    pane.replaceChildren();
    root.querySelector("h1")?.remove();
    root.prepend(el("h1", { tabindex: "-1" }, "Agent"));
    if (!ctx.owner) {
      pane.append(
        el("p", {}, "Sign in as the installation owner to use agents."),
      );
      return;
    }
    if (!baseline) {
      pane.append(
        el(
          "p",
          {},
          "Choose an exact Release before sending project context to an agent.",
        ),
      );
      return;
    }
    if (!status.initialized || !status.connections.length) {
      pane.append(
        el(
          "p",
          {},
          "Add a Cloudflare agent or pair a local Codex or Claude runner in Settings.",
        ),
        el("a", { href: "#/settings" }, "Open Settings"),
      );
      return;
    }
    const selection = el(
      "select",
      {
        "aria-label": "Agent",
        disabled: disabled || !!conversation,
        onchange: (e) => {
          selected = e.target.value;
          paint();
        },
      },
      ...status.connections
        .filter((c) => c.enabled && !c.revoked)
        .map((c) =>
          el(
            "option",
            { value: c.id, selected: c.id === selected },
            c.label + " · " + c.provider,
          ),
        ),
    );
    const connection = status.connections.find((c) => c.id === selected);
    pane.append(
      el(
        "article",
        { class: "card" },
        el("label", {}, "Agent", selection),
        fields([
          ["Baseline", conversation?.context?.baseline ?? baseline],
          ["Context", "Selected project intent and this conversation"],
          ["Draft owner", ctx.workflow?.principal_id ?? "Authenticated owner"],
        ]),
        el(
          "p",
          {},
          "Conversation and proposal output are saved privately until removed. Agents do not publish or approve changes.",
        ),
        connection && ["codex", "claude"].includes(connection.provider) ? el(
          "p", {},
          "This paired agent can use the selected project intent and this conversation until disconnected or revoked. Starting a conversation shares only this context.",
        ) : el(
          "button",
          {
            disabled: disabled || !connection || !!conversation,
            onclick: () =>
              run({
                action: "consent",
                connection_id: selected,
                generation: connection.generation,
                baseline,
                context: "selected-intent",
                retention: "until-removed",
                limits: connection.limits ?? defaultAgentLimits,
              }),
          },
          "Allow this agent to read project context",
        ),
        el(
          "button",
          {
            disabled: disabled || !connection || !!conversation,
            onclick: () =>
              run({
                action: "conversation",
                connection_id: selected,
                baseline,
                title: "Project conversation",
              }),
          },
          "Start conversation",
        ),
        el(
          "button",
          {
            disabled: busy,
            onclick: async () => {
              try {
                const rows = await ctx.agentRequest(
                  "conversations?baseline=" + encodeURIComponent(baseline),
                );
                pane.append(
                  el(
                    "article",
                    { class: "card" },
                    el("h3", {}, "Saved conversations"),
                    ...rows.map((c) =>
                      el(
                        "button",
                        {
                          onclick: () =>
                            run({ action: "inspect", conversation_id: c.id }),
                        },
                        c.title + " · " + c.created_at,
                      ),
                    ),
                  ),
                );
              } catch (e) {
                notice.textContent = e.message;
              }
            },
          },
          "Open saved conversations",
        ),
      ),
    );
    if (client.pending)
      pane.append(
        el(
          "article",
          { class: "card" },
          el("p", {}, "Original operation: " + client.pending.id),
          el(
            "button",
            {
              onclick: async () => {
                try {
                  const r = await client.inspect();
                  notice.textContent = "Original outcome: " + r.state;
                  paint();
                  if (
                    r.request_metadata?.action === "save" &&
                    !["completed", "failed"].includes(r.state)
                  )
                    notice.append(
                      el(
                        "button",
                        {
                          onclick: () =>
                            run({
                              action: "inspect-save",
                              source_request_id: r.id,
                            }),
                        },
                        "Inspect original saved draft",
                      ),
                    );
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
                    "Keep this original action unresolved and allow independent new work? Its server receipt is retained; this never replays it.",
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
    if (!conversation) return;
    if (archived)
      pane.append(
        el(
          "p",
          { class: "notice" },
          "This conversation is retained for reading. Start a new conversation with current connection consent to send another message.",
        ),
      );
    pane.append(
      el(
        "div",
        { class: "toolbar" },
        el(
          "button",
          {
            disabled: busy,
            onclick: () =>
              run({ action: "inspect", conversation_id: conversation.id }),
          },
          "Refresh conversation",
        ),
        el(
          "button",
          {
            disabled: busy,
            onclick: () => {
              conversation = null;
              history = [];
              archived = false;
              paint();
            },
          },
          "New conversation",
        ),
      ),
    );
    for (const turn of history) {
      pane.append(
        el(
          "article",
          { class: "card" },
          el("h3", {}, "You"),
          el("p", {}, turn.request.messages.at(-1)?.text ?? ""),
          pill(turn.state),
          turn.draft_ref
            ? el(
                "a",
                {
                  href:
                    ctx.href?.("review", {
                      ref: turn.draft_ref,
                      type: "layer",
                    }) ?? "#/review?ref=" + encodeURIComponent(turn.draft_ref),
                },
                "Open saved draft",
              )
            : null,
          turn.output?.text
            ? el("p", {}, turn.output.text)
            : turn.events?.some((e) => e.kind === "text")
              ? el(
                  "p",
                  {},
                  turn.events
                    .filter((e) => e.kind === "text")
                    .map((e) => e.text ?? "")
                    .join(""),
                )
              : null,
          ["queued", "running", "cancel_requested", "interrupted"].includes(
            turn.state,
          ) && !archived
            ? el(
                "button",
                {
                  disabled: busy,
                  onclick: () => run({ action: "cancel", turn_id: turn.id }),
                },
                "Stop this turn",
              )
            : null,
        ),
      );
      if (turn.output?.proposal) {
        const p = turn.output.proposal,
          unsupported = p.changes.some((c) => !supportedExpected(c.expected)),
          layer = el("input", {
            "aria-label": "New draft Layer ID",
            value: draftIds.get(turn.id) ?? "L-agent-" + turn.id.slice(0, 8),
            oninput: (e) => draftIds.set(turn.id, e.target.value),
            required: true,
          });
        pane.append(
          el(
            "article",
            { class: "card" },
            el("h3", {}, "Proposed draft"),
            el("p", {}, p.intent),
            ...p.changes.map((c) =>
              el(
                "div",
                {},
                el("strong", {}, c.block + " · " + c.path),
                el(
                  "p",
                  {},
                  el("strong", {}, "Before: "),
                  expectedPreview(c.expected),
                ),
                el(
                  "p",
                  {},
                  el("strong", {}, "After: "),
                  typeof c.value === "string"
                    ? c.value
                    : JSON.stringify(c.value),
                ),
                el(
                  "details",
                  {},
                  el("summary", {}, "Exact change data"),
                  el("pre", {}, JSON.stringify(c, null, 2)),
                ),
              ),
            ),
            ...p.questions.map((q) => el("p", { class: "notice" }, q)),
            unsupported ? el("p", { class: "notice" }, "This retained proposal has an unsupported expected value and cannot be saved. You can continue the conversation.") : null,
            el(
              "form",
              {
                onsubmit: async (e) => {
                  e.preventDefault();
                  if (unsupported) return;
                  const bytes = new TextEncoder().encode(
                      JSON.stringify(canonical(p)),
                    ),
                    hash = [
                      ...new Uint8Array(
                        await crypto.subtle.digest("SHA-256", bytes),
                      ),
                    ]
                      .map((b) => b.toString(16).padStart(2, "0"))
                      .join("");
                  void run({
                    action: "save",
                    turn_id: turn.id,
                    proposal_sha256: hash,
                    layer_id: layer.value,
                  });
                },
              },
              el("label", {}, "New draft Layer ID", layer),
              el(
                "button",
                {
                  type: "submit",
                  disabled:
                    disabled ||
                    unsupported ||
                    p.questions.length > 0 ||
                    turnSaved.has(turn.id) ||
                    turn.saved,
                },
                "Save as draft",
              ),
            ),
          ),
        );
      }
    }
    const message = el("textarea", {
      "aria-label": "Message to agent",

      value: draftText,
      oninput: (e) => (draftText = e.target.value),
      rows: 4,
      required: true,
      maxlength: 8192,
    });
    pane.append(
      el(
        "form",
        {
          class: "card",
          onsubmit: (e) => {
            e.preventDefault();
            void run({
              action: "turn",
              conversation_id: conversation.id,
              kind: "chat",
              text: message.value,
            });
          },
        },
        el("label", {}, "Message", message),
        el("button", { type: "submit", disabled }, "Send message"),
        el(
          "button",
          {
            type: "button",
            disabled,
            onclick: () =>
              run({
                action: "turn",
                conversation_id: conversation.id,
                kind: "proposal",
                text:
                  message.value ||
                  "Prepare a draft proposal based on our conversation. Return unresolved questions if necessary.",
              }),
          },
          "Prepare draft",
        ),
      ),
    );
    watch();
  }
  root.append(pane, notice);
  paint();
  return root;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
