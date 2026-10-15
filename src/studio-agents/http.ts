import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { ExplorerError } from "../explorer/contract.js";
import { OwnerAccess } from "../explorer/owner-access.js";
import { AgentHubError, key } from "./protocol.js";
import { StudioAgentHub, type AgentProjectPort } from "./hub.js";

async function body(req: IncomingMessage, max = 65536) {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw new AgentHubError("AGENT_LIMIT", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AgentHubError("AGENT_INVALID", 400);
  }
}
function empty(req: IncomingMessage) {
  if (
    req.headers["transfer-encoding"] ||
    (req.headers["content-length"] && req.headers["content-length"] !== "0")
  )
    throw new AgentHubError("AGENT_INVALID", 400);
}
export class StudioAgentHttp {
  constructor(
    readonly hub: StudioAgentHub,
    private owner: OwnerAccess,
    private project: (req: IncomingMessage) => Promise<AgentProjectPort>,
    private downloadFile?: string,
  ) {}
  async handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const ownerPrefix = "/studio/v1/owner/agent-",
      runnerPrefix = "/studio/v1/agent-runners/";
    if (
      !url.pathname.startsWith(ownerPrefix) &&
      !url.pathname.startsWith(runnerPrefix)
    )
      return false;
    let attemptedAction = false;
    try {
      let result: unknown, assertOwner: (() => void) | undefined;
      if (url.pathname.startsWith(runnerPrefix)) {
        if (
          req.method !== "POST" ||
          req.headers.cookie ||
          req.headers.origin ||
          url.search ||
          req.headers["content-type"] !== "application/json"
        )
          throw new AgentHubError("AGENT_AUTH", 403);
        if (url.pathname === runnerPrefix + "pair") {
          if (req.headers.authorization)
            throw new AgentHubError("AGENT_AUTH", 403);
          result = await this.hub.pair(await body(req, 2048));
        } else {
          const match = url.pathname.match(
              /^\/studio\/v1\/agent-runners\/([a-f0-9-]{36})\/(poll|output|login|progress)$/,
            ),
            auth = String(req.headers.authorization ?? "").match(
              /^Bearer ([A-Za-z0-9_-]{43})$/,
            );
          if (!match || !auth) throw new AgentHubError("AGENT_AUTH", 403);
          if (match[2] === "poll") {
            const p = z
              .object({ ready: z.boolean(), busy: z.boolean().optional(), models: z.array(key).max(256).optional() })
              .strict()
              .safeParse(await body(req));
            if (!p.success) throw new AgentHubError("AGENT_INVALID", 400);
            result = await this.hub.poll(
              match[1],
              auth[1],
              p.data.ready,
              p.data.busy,
              p.data.models,
            );
          } else
            result =
              match[2] === "progress"
                ? await this.hub.progress(match[1], auth[1], await body(req))
                : match[2] === "login"
                  ? await this.hub.loginOutput(
                      match[1],
                      auth[1],
                      await body(req, 1024),
                    )
                  : await this.hub.output(match[1], auth[1], await body(req));
        }
      } else {
        if (req.headers.authorization || req.headers["x-studio-client"])
          throw new AgentHubError("AGENT_AUTH", 403);
        if (!["GET", "POST"].includes(req.method ?? ""))
          throw new AgentHubError("AGENT_INVALID", 405);
        if (
          req.method === "POST" &&
          (req.headers.origin !== this.owner.origin ||
            req.headers["content-type"] !== "application/json" ||
            url.search)
        )
          throw new AgentHubError("AGENT_AUTH", 403);
        await this.owner.require(req);
        const delivery = await this.owner.actorAuthentication(req, false);
        assertOwner = () => delivery.assertLive();
        if (req.method === "GET") {
          empty(req);
          if (
            url.pathname === ownerPrefix + "runner-download" &&
            !url.search &&
            this.downloadFile
          ) {
            const packageBytes = await readFile(this.downloadFile);
            if (packageBytes.length > 2 * 1024 * 1024)
              throw new AgentHubError("AGENT_LIMIT", 413);
            res.setHeader("content-type", "application/zip");
            res.setHeader(
              "content-disposition",
              'attachment; filename="strata-agent-runner.zip"',
            );
            assertOwner();
            res.end(packageBytes);
            return true;
          }
          const authority = await this.owner.actorAuthentication(req, false);
          if (url.pathname === ownerPrefix + "connections" && !url.search)
            result = await this.hub.status(authority);
          else if (
            url.pathname === ownerPrefix + "conversations" &&
            url.searchParams.size === 1 &&
            url.searchParams.has("baseline")
          )
            result = await this.hub.conversations(
              authority,
              await this.project(req),
              url.searchParams.get("baseline")!,
            );
          else if (
            /^\/studio\/v1\/owner\/agent-conversations\/[a-f0-9-]{36}$/.test(
              url.pathname,
            ) &&
            !url.search
          )
            result = await this.hub.inspect(
              authority,
              await this.project(req),
              url.pathname.split("/").at(-1)!,
              false,
            );
          else if (
            url.pathname.match(
              /^\/studio\/v1\/owner\/agent-operations\/[a-f0-9-]{36}$/,
            ) &&
            !url.search
          )
            result = await this.hub.outcome(
              authority,
              url.pathname.split("/").at(-1)!,
            );
          else throw new AgentHubError("AGENT_NOT_FOUND", 404);
        } else {
          if (url.pathname !== ownerPrefix + "connections")
            throw new AgentHubError("AGENT_NOT_FOUND", 404);
          const input = await body(req, 16384),
            action = (input as { action?: string })?.action;
          const fresh = ![
            // The existing pairing already authorizes local model selection.
            // New pairing and credential management still require fresh auth.
            "add-runner",
            "conversation",
            "turn",
            "cancel",
            "inspect",
            "inspect-save",
            "save",
          ].includes(action ?? "");
          const authority = await this.owner.actorAuthentication(req, fresh);
          // Installation setup does not require a selected project. Its port is
          // never used by pairing/credential/deployment actions.
          const project: AgentProjectPort = [
            "consent",
            "conversation",
            "turn",
            "cancel",
            "inspect",
            "inspect-save",
            "save",
          ].includes(action ?? "")
            ? await this.project(req)
            : {
                context: async () => {
                  throw new AgentHubError("AGENT_SOURCE_UNAVAILABLE");
                },
                save: async () => {
                  throw new AgentHubError("AGENT_SOURCE_UNAVAILABLE");
                },
              };
          attemptedAction = true;
          result = await this.hub.action(authority, project, input);
        }
      }
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 3 * 1024 * 1024)
        throw new AgentHubError("AGENT_LIMIT", 413);
      res.setHeader("content-type", "application/json");
      assertOwner?.();
      res.end(text);
    } catch (e) {
      const safe =
        e instanceof AgentHubError
          ? e
          : e instanceof ExplorerError
            ? { status: e.status, code: e.code, message: e.message }
            : new AgentHubError("AGENT_STATE_UNAVAILABLE", 503);
      res.statusCode = safe.status;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: safe.code,
            message: safe.message,
            ...(url.pathname.startsWith(ownerPrefix) && req.method === "POST"
              ? { before_admission: !attemptedAction }
              : {}),
          },
        }),
      );
    }
    return true;
  }
}
