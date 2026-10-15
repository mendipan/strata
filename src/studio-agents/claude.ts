import path from "node:path";
import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { digest } from "../model.js";
import { AgentHubState } from "./state.js";
import {
  AgentHubError,
  bounded,
  proposalSchema,
  turnOutputSchema,
  type TurnRequest,
  type TurnOutput,
} from "./protocol.js";

export const CLAUDE_SDK_VERSION = "0.3.296";
export interface ClaudeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
}
export interface ClaudeSdkPort {
  version: string;
  query(input: {
    prompt: string;
    options: Record<string, unknown>;
  }): ClaudeQuery;
}
const recordSchema = z
  .object({
    request_sha256: z.string(),
    session_id: z.string().nullable(),
    state: z.enum(["reserved", "running", "completed", "uncertain"]),
    output: turnOutputSchema.nullable(),
  })
  .strict();
/** Local SDK bridge, with separate credential custody and no inherited tools. */
export class ClaudeChatBridge {
  private active = new Map<string, ClaudeQuery>();
  constructor(
    private sdk: ClaudeSdkPort,
    private journal: AgentHubState,
    private snapshots: string,
    private credential: () => Promise<string>,
  ) {
    if (sdk.version !== CLAUDE_SDK_VERSION)
      throw new AgentHubError("AGENT_UNCONFIGURED");
  }
  async cancel(taskId: string) {
    await this.active.get(taskId)?.interrupt();
  }
  async inspect(request: TurnRequest): Promise<TurnOutput | null> {
    return this.journal.transaction(async (tx) => {
      const raw = await tx.get("claude/" + request.task_id);
      if (!raw) return null;
      const record = recordSchema.parse(raw);
      if (record.request_sha256 !== digest(request))
        throw new AgentHubError("AGENT_STALE");
      return record.output;
    });
  }
  async run(
    request: TurnRequest,
    onText: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<TurnOutput> {
    if (signal.aborted) throw new AgentHubError("AGENT_STALE");
    const key = "claude/" + request.task_id,
      requestHash = digest(request),
      old = await this.journal.transaction(async (tx) => {
        const previous = await tx.get(key);
        if (previous) return recordSchema.parse(previous);
        await tx.put(key, {
          request_sha256: requestHash,
          session_id: null,
          state: "reserved",
          output: null,
        });
        return null;
      });
    if (old) {
      if (old.request_sha256 !== requestHash)
        throw new AgentHubError("AGENT_STALE");
      if (old.output) return old.output;
      throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
    }
    const directory = path.join(this.snapshots, request.task_id);
    await mkdir(directory, { mode: 0o700 });
    const controller = new AbortController(),
      abort = () => {
        controller.abort();
        void this.cancel(request.task_id).catch(() => {});
      };
    signal.addEventListener("abort", abort, { once: true });
    let sessionId: string | null = null;
    try {
      const env: Record<string, string> = {
        ANTHROPIC_API_KEY: await this.credential(),
        CLAUDE_CONFIG_DIR: path.join(
          path.dirname(this.snapshots),
          "claude-home",
        ),
      };
      for (const name of [
        "PATH",
        "SystemRoot",
        "SYSTEMROOT",
        "WINDIR",
        "TEMP",
        "TMP",
      ])
        if (process.env[name]) env[name] = process.env[name]!;
      const query = this.sdk.query({
        prompt: JSON.stringify({
          kind: request.kind,
          context: request.context,
          context_sha256: request.context_sha256,
          messages: request.messages,
        }),
        options: {
          cwd: directory,
          model: request.model,
          tools: [],
          allowedTools: [],
          mcpServers: {},
          plugins: [],
          settingSources: [],
          permissionMode: "dontAsk",
          stderr: () => {},
          canUseTool: async () => ({
            behavior: "deny",
            message:
              "This connection authorizes supplied intent context and proposal output only.",
          }),
          persistSession: true,
          maxTurns: 1,
          abortController: controller,
          env,
          systemPrompt:
            "Assist with the supplied Strata intent. Do not claim evidence or approvals. Return a proposal only for the exact baseline/context.",
          ...(request.kind === "proposal"
            ? {
                outputFormat: {
                  type: "json_schema",
                  schema: z.toJSONSchema(proposalSchema),
                },
              }
            : {}),
        },
      });
      this.active.set(request.task_id, query);
      let text = "",
        result: TurnOutput | null = null;
      for await (const raw of query) {
        if (controller.signal.aborted)
          throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
        const message = bounded(
          z.object({ type: z.string() }).passthrough(),
          raw,
          65536,
        ) as Record<string, unknown>;
        if (typeof message.session_id === "string") {
          if (sessionId && sessionId !== message.session_id)
            throw new AgentHubError("AGENT_STALE");
          sessionId = message.session_id;
          await this.journal.transaction(async (tx) => {
            await tx.put(key, {
              request_sha256: requestHash,
              session_id: sessionId,
              state: "running",
              output: null,
            });
          });
        }
        if (message.type === "assistant") {
          const payload = message.message as {
            content?: { type: string; text?: string }[];
          };
          for (const item of payload?.content ?? []) {
            if (item.type === "tool_use")
              throw new AgentHubError("AGENT_AUTH", 403);
            if (item.type === "text" && typeof item.text === "string") {
              text += item.text;
              if (Buffer.byteLength(text) > request.limits.output_bytes)
                throw new AgentHubError("AGENT_LIMIT");
              await onText(item.text);
            }
          }
        }
        if (message.type === "result") {
          const succeeded = message.subtype === "success",
            scalar = typeof message.result === "string" ? message.result : text;
          const proposal =
            succeeded && request.kind === "proposal"
              ? bounded(
                  proposalSchema,
                  message.structured_output ?? JSON.parse(scalar),
                  request.limits.output_bytes,
                )
              : null;
          result = bounded(
            turnOutputSchema,
            {
              format: "strata-agent-chat-output/1",
              task_id: request.task_id,
              request_sha256: requestHash,
              state: succeeded ? "succeeded" : "failed",
              text: proposal ? proposal.intent : scalar,
              proposal,
              code: succeeded ? null : "AGENT_NATIVE_FAILED",
            },
            request.limits.output_bytes,
          );
        }
      }
      if (!result || controller.signal.aborted)
        throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
      if (
        result.proposal &&
        (result.proposal.context_sha256 !== request.context_sha256 ||
          result.proposal.baseline !== request.context.baseline)
      )
        throw new AgentHubError("AGENT_STALE");
      await this.journal.transaction(async (tx) => {
        await tx.put(key, {
          request_sha256: requestHash,
          session_id: sessionId,
          state: "completed",
          output: result,
        });
      });
      return result;
    } catch {
      controller.abort();
      void this.cancel(request.task_id).catch(() => {});
      await this.journal
        .transaction(async (tx) => {
          await tx.put(key, {
            request_sha256: requestHash,
            session_id: sessionId,
            state: "uncertain",
            output: null,
          });
        })
        .catch(() => {});
      throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(request.task_id);
    }
  }
}
