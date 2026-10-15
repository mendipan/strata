import { Agent } from "agents";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { digest } from "../model.js";
import {
  AgentHubError,
  bounded,
  turnRequestSchema,
  turnOutputSchema,
  proposalSchema,
  type TurnRequest,
  type TurnOutput,
} from "./protocol.js";

interface Env extends StudioAgentBindings {
  MODEL: string;
  SERVICE_ID: string;
  BUNDLE_SHA256: string;
  RUNTIME_TOKEN: string;
  IDENTITY_PRIVATE_KEY: string;
}
const retained = z
  .object({
    request: turnRequestSchema,
    request_sha256: z.string(),
    text: z.string().max(16384).default(""),
    state: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "cancel_requested",
      "interrupted",
    ]),
    output: turnOutputSchema.nullable(),
  })
  .strict();
async function input(req: Request, max = 65536) {
  if (req.headers.get("content-type") !== "application/json")
    throw new AgentHubError("AGENT_INVALID", 400);
  const reader = req.body?.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  if (reader)
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > max) throw new AgentHubError("AGENT_LIMIT", 413);
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  try {
    return JSON.parse(
      Buffer.concat(parts.map((p) => Buffer.from(p))).toString(),
    );
  } catch {
    throw new AgentHubError("AGENT_INVALID", 400);
  }
}
export class StudioAgent extends Agent<Env> {
  private readonly active = new Map<string, AbortController>();
  private authorized(req: Request) {
    const supplied = req.headers.get("authorization") ?? "",
      expected = "Bearer " + this.env.RUNTIME_TOKEN;
    if (
      !this.env.RUNTIME_TOKEN ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      throw new AgentHubError("AGENT_AUTH", 403);
  }
  private async reply(payload: unknown, status = 200) {
    const data = JSON.stringify(payload),
      key = await crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(Buffer.from(this.env.IDENTITY_PRIVATE_KEY, "base64url")),
        { name: "Ed25519" },
        false,
        ["sign"],
      );
    const signature = await crypto.subtle.sign(
      "Ed25519",
      key,
      new TextEncoder().encode(data),
    );
    return Response.json(
      { payload, signature: Buffer.from(signature).toString("base64url") },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
  async onRequest(req: Request): Promise<Response> {
    try {
      this.authorized(req);
      const url = new URL(req.url);
      if (url.search || req.headers.get("cookie"))
        throw new AgentHubError("AGENT_INVALID", 400);
      if (url.pathname === "/identity" && req.method === "GET")
        return this.reply({
          service_id: this.env.SERVICE_ID,
          model: this.env.MODEL,
          bundle_sha256: this.env.BUNDLE_SHA256,
          initialized:
            (await this.ctx.storage.get("genesis")) === this.env.SERVICE_ID,
        });
      if (url.pathname === "/initialize" && req.method === "POST") {
        const p = z
          .object({ service_id: z.string().uuid() })
          .strict()
          .parse(await input(req, 128));
        if (p.service_id !== this.env.SERVICE_ID)
          throw new AgentHubError("AGENT_AUTH", 403);
        await this.ctx.storage.transaction(async (tx) => {
          const old = await tx.get("genesis");
          if (old && old !== this.env.SERVICE_ID)
            throw new AgentHubError("AGENT_STALE");
          if (!old) await tx.put("genesis", this.env.SERVICE_ID);
        });
        return this.reply({
          service_id: this.env.SERVICE_ID,
          initialized: true,
        });
      }
      if ((await this.ctx.storage.get("genesis")) !== this.env.SERVICE_ID)
        throw new AgentHubError("AGENT_UNCONFIGURED", 503);
      if (url.pathname === "/turns" && req.method === "POST") {
        const request = bounded(turnRequestSchema, await input(req));
        if (request.model !== this.env.MODEL)
          throw new AgentHubError("AGENT_MODEL_UNSUPPORTED", 422);
        const requestHash = digest(request);
        const fresh = await this.ctx.storage.transaction(async (tx) => {
          const prior = await tx.get("turn/" + request.task_id);
          if (prior) {
            if (retained.parse(prior).request_sha256 !== requestHash)
              throw new AgentHubError("AGENT_STALE");
            return false;
          }
          if ((await tx.list({ prefix: "turn/", limit: 256 })).size >= 256)
            throw new AgentHubError("AGENT_LIMIT");
          await tx.put("turn/" + request.task_id, {
            request,
            request_sha256: requestHash,
            state: "queued",
            text: "",
            output: null,
          });
          return true;
        });
        if (fresh) this.ctx.waitUntil(this.run(request));
        const row = retained.parse(
          await this.ctx.storage.get("turn/" + request.task_id),
        );
        return this.reply({
          task_id: request.task_id,
          request_sha256: requestHash,
          state: row.state,
        });
      }
      const match = url.pathname.match(/^\/turns\/([a-f0-9-]{36})(\/cancel)?$/);
      if (!match) throw new AgentHubError("AGENT_NOT_FOUND", 404);
      const raw = await this.ctx.storage.get("turn/" + match[1]);
      if (!raw) throw new AgentHubError("AGENT_NOT_FOUND", 404);
      let row = retained.parse(raw);
      if (match[2] && req.method === "POST") {
        z.object({})
          .strict()
          .parse(await input(req, 16));
        if (!["succeeded", "failed", "cancelled"].includes(row.state)) {
          row = { ...row, state: "cancel_requested" };
          await this.ctx.storage.put("turn/" + match[1], row);
          this.active.get(match[1])?.abort();
        }
        return this.reply({ task_id: match[1], state: row.state });
      }
      if (req.method !== "GET" || match[2])
        throw new AgentHubError("AGENT_INVALID", 405);
      if (
        ["queued", "running", "cancel_requested"].includes(row.state) &&
        !this.active.has(match[1])
      ) {
        row = { ...row, state: "interrupted" };
        await this.ctx.storage.put("turn/" + match[1], row);
      }
      return this.reply({
        task_id: match[1],
        request_sha256: row.request_sha256,
        state: row.state,
        output: row.output,
        text: row.output ? "" : row.text,
      });
    } catch (e) {
      const error =
        e instanceof AgentHubError
          ? e
          : new AgentHubError("AGENT_INVALID", 422);
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
  }
  private async run(request: TurnRequest) {
    const controller = new AbortController();
    this.active.set(request.task_id, controller);
    const timer = setTimeout(
      () => controller.abort(),
      request.limits.runtime_ms,
    );
    const key = "turn/" + request.task_id,
      requestHash = digest(request);
    let output: TurnOutput;
    try {
      const old = retained.parse(await this.ctx.storage.get(key));
      await this.ctx.storage.put(key, { ...old, state: "running" });
      const system =
        "You assist with Strata intent. Only the supplied context is authorized. Do not execute code, contact services or claim evidence/approval. " +
        (request.kind === "proposal"
          ? "Return one JSON object matching strata-agent-draft-proposal/1 with the exact baseline and context_sha256, intent, up to 25 set_item changes with exact expected values, and questions. If a decision is missing, return questions with no changes. Do not invent acceptance evidence."
          : "Explain the project and answer the user in plain text.");
      const response = await this.env.AI.run(
        this.env.MODEL as keyof AiModels,
        {
          messages: [
            {
              role: "system",
              content:
                system +
                "\nContext: " +
                JSON.stringify(request.context) +
                "\ncontext_sha256: " +
                request.context_sha256 +
                (request.kind === "proposal"
                  ? "\nProposal schema: " +
                    JSON.stringify(z.toJSONSchema(proposalSchema))
                  : ""),
            },
            ...request.messages.map((m) => ({ role: m.role, content: m.text })),
          ],
          max_tokens: request.limits.max_output_tokens,
          stream: request.kind === "chat",
          ...(request.kind === "proposal"
            ? { response_format: { type: "json_object" } }
            : {}),
        },
        { signal: controller.signal },
      );
      if (controller.signal.aborted) throw new AgentHubError("AGENT_STALE");
      let streamed = "";
      if (response instanceof ReadableStream) {
        const reader = response.getReader(),
          decoder = new TextDecoder();
        let buffer = "",
          rawBytes = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            rawBytes += value.byteLength;
            if (rawBytes > request.limits.output_bytes * 4)
              throw new AgentHubError("AGENT_LIMIT");
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end).trim();
              buffer = buffer.slice(end + 1);
              if (!line.startsWith("data:") || line === "data: [DONE]")
                continue;
              const token = JSON.parse(line.slice(5));
              if (typeof token.response === "string")
                streamed += token.response;
              if (
                Buffer.byteLength(streamed) > request.limits.output_bytes ||
                streamed.length > 16384
              )
                throw new AgentHubError("AGENT_LIMIT");
            }
            if (controller.signal.aborted)
              throw new AgentHubError("AGENT_STALE");
            await this.ctx.storage.transaction(async (tx) => {
              const row = retained.parse(await tx.get(key));
              if (row.state === "cancel_requested") controller.abort();
              else await tx.put(key, { ...row, text: streamed });
            });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      const text =
        streamed ||
        (typeof response === "object" &&
        response &&
        "response" in response &&
        typeof response.response === "string"
          ? response.response
          : request.kind === "proposal" &&
              typeof response === "object" &&
              response &&
              "response" in response &&
              typeof response.response === "object"
            ? JSON.stringify(response.response)
            : "");
      if (!text || Buffer.byteLength(text) > request.limits.output_bytes)
        throw new AgentHubError("AGENT_INVALID");
      const proposal =
        request.kind === "proposal"
          ? bounded(
              proposalSchema,
              JSON.parse(text),
              request.limits.output_bytes,
            )
          : null;
      if (
        proposal &&
        (proposal.baseline !== request.context.baseline ||
          proposal.context_sha256 !== request.context_sha256)
      )
        throw new AgentHubError("AGENT_STALE");
      output = turnOutputSchema.parse({
        format: "strata-agent-chat-output/1",
        task_id: request.task_id,
        request_sha256: requestHash,
        state: "succeeded",
        text: proposal ? proposal.intent : text,
        proposal,
        code: null,
      });
    } catch {
      output = {
        format: "strata-agent-chat-output/1",
        trust: "agent-output",
        task_id: request.task_id,
        request_sha256: requestHash,
        state: "failed",
        text: "",
        proposal: null,
        code: controller.signal.aborted
          ? "AGENT_STOP_UNCONFIRMED"
          : "AGENT_OUTPUT_INVALID",
      };
    } finally {
      clearTimeout(timer);
      this.active.delete(request.task_id);
    }
    await this.ctx.storage.transaction(async (tx) => {
      const old = retained.parse(await tx.get(key));
      if (old.output) return;
      await tx.put(key, { ...old, state: output.state, output });
    });
  }
}
export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url),
      supplied = req.headers.get("authorization") ?? "",
      expected = "Bearer " + env.RUNTIME_TOKEN;
    // Gate before Agent base routing, including SDK websocket and RPC surfaces.
    if (
      !env.RUNTIME_TOKEN ||
      supplied.length !== expected.length ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return Response.json({ error: { code: "AGENT_AUTH" } }, { status: 403 });
    const allowed =
      (req.method === "GET" &&
        (url.pathname === "/identity" ||
          /^\/turns\/[a-f0-9-]{36}$/.test(url.pathname))) ||
      (req.method === "POST" &&
        (url.pathname === "/initialize" ||
          url.pathname === "/turns" ||
          /^\/turns\/[a-f0-9-]{36}\/cancel$/.test(url.pathname)));
    if (
      !allowed ||
      url.search ||
      req.headers.has("cookie") ||
      req.headers.has("origin") ||
      req.headers.has("upgrade")
    )
      return Response.json(
        { error: { code: "AGENT_INVALID" } },
        { status: 400 },
      );
    if (
      req.method === "POST" &&
      req.headers.get("content-type") !== "application/json"
    )
      return Response.json(
        { error: { code: "AGENT_INVALID" } },
        { status: 400 },
      );
    return env.AGENT.get(env.AGENT.idFromName("installation")).fetch(req);
  },
} satisfies ExportedHandler<Env>;
