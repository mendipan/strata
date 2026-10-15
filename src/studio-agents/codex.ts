import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { digest } from "../model.js";
import {
  AgentHubError,
  bounded,
  turnOutputSchema,
  type TurnRequest,
  type TurnOutput,
} from "./protocol.js";
import { AgentHubState } from "./state.js";
import { codexProposalOutputSchema, parseCodexProposal } from "./codex-proposal.js";

export const CODEX_QUALIFICATION_VERSION = "0.162.1";
export const CODEX_SCHEMA_PIN = "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d";
/** Session flags only: no user/system config is written and MXC has no fallback. */
export const CODEX_PROCESS_OVERRIDES = [
  'cli_auth_credentials_store="file"',
  'windows.sandbox="mxc"',
] as const;
export function codexTurnProfile(taskId: string, directory: string) {
  const id = "strata_proposal_" + taskId.replaceAll("-", "");
  return { id, profile: {
    filesystem: { ":root": "deny", [directory]: "read" },
    network: { enabled: false },
  } };
}
export interface CodexRpc {
  call(method: string, params: unknown, lateReply?: (value: unknown) => Promise<void>): Promise<unknown>;
  onEvent(listener: (method: string, params: unknown) => void): () => void;
  close(): void;
}
const methods = new Set([
  "initialize",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "model/list",
  "thread/start",
  "thread/read",
  "turn/start",
  "turn/interrupt",
]);
/** Dedicated process, never a desktop daemon/proxy. Raw errors are not surfaced. */
export class CodexProcess implements CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private events = new EventEmitter();
  private decoder = new StringDecoder("utf8");
  private serial = 0;
  private buffer = "";
  private waits = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
      expired: boolean;
      lateReply?: (value: unknown) => Promise<void>;
    }
  >();
  constructor(binary: string, home: string, cwd: string) {
    if (
      !path.isAbsolute(binary) ||
      !path.isAbsolute(home) ||
      !path.isAbsolute(cwd) ||
      /\.(ps1|cmd|bat)$/i.test(binary)
    )
      throw new AgentHubError("AGENT_INVALID");
    const env: NodeJS.ProcessEnv = {};
    for (const name of [
      "PATH",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
    ])
      if (process.env[name]) env[name] = process.env[name];
    env.CODEX_HOME = home;
    env.HOME = home;
    env.USERPROFILE = home;
    // PSEC requires this name even with an explicit environment. Keep it private;
    // the path does not grant sandbox access to the home or desktop AppData.
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    this.child = spawn(binary, ["app-server", "--listen", "stdio://",
      ...CODEX_PROCESS_OVERRIDES.flatMap(value => ["--config", value])], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) =>
      this.consume(this.decoder.write(Buffer.from(chunk))),
    );
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.failed());
    this.child.on("exit", () => this.failed());
  }
  private failed() {
    for (const w of this.waits.values()) {
      clearTimeout(w.timer);
      w.reject(new AgentHubError("AGENT_RUNTIME_OFFLINE", 503));
    }
    this.waits.clear();
    this.events.emit("event", "runner/disconnected", {});
  }
  private consume(text: string) {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > 128 * 1024) { this.close(); return; }
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.close();
        return;
      }
      if (message.id !== undefined && this.waits.has(message.id)) {
        const w = this.waits.get(message.id)!;
        this.waits.delete(message.id);
        clearTimeout(w.timer);
        if (message.error) w.reject(new AgentHubError("AGENT_INVALID"));
        else if (w.expired) void w.lateReply?.(message.result).catch(() => {});
        else w.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        this.child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message:
                "This runner does not authorize interactive tools or approvals.",
            },
          }) + "\n",
        );
      } else if (typeof message.method === "string")
        this.events.emit("event", message.method, message.params);
    }
    if (Buffer.byteLength(this.buffer) > 128 * 1024) this.close();
  }
  call(method: string, params: unknown, lateReply?: (value: unknown) => Promise<void>): Promise<unknown> {
    if (!methods.has(method))
      return Promise.reject(new AgentHubError("AGENT_AUTH", 403));
    if (lateReply && method !== "turn/start")
      return Promise.reject(new AgentHubError("AGENT_INVALID"));
    // Expired admission waits retain only their exact RPC receipt until reply or
    // disconnect. Refuse more admission at capacity without blocking interrupts.
    if (lateReply && this.waits.size >= 256)
      return Promise.reject(new AgentHubError("AGENT_LIMIT"));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const wait = this.waits.get(id);
        if (!wait) return;
        if (lateReply) wait.expired = true;
        else this.waits.delete(id);
        reject(new AgentHubError("AGENT_RECOVERY_REQUIRED"));
      }, 10000);
      this.waits.set(id, { resolve, reject, timer, expired: false, lateReply });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  notifyInitialized() {
    this.child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
  }
  onEvent(listener: (method: string, params: unknown) => void) {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }
  close() {
    this.child.stdin.end();
    this.child.kill();
    this.failed();
  }
}
const nativeRecord = z
  .object({
    request_sha256: z.string(),
    thread_id: z.string().nullable(),
    turn_id: z.string().nullable(),
    state: z.enum(["reserved", "running", "completed", "uncertain"]),
    output: turnOutputSchema.nullable(),
  })
  .strict();
const nativeTurnReply = z.object({
  turn: z.object({ id: z.string().min(1).max(256) }).passthrough(),
}).passthrough();
type Cancellation = { requested: boolean; terminal: boolean; interrupt: Promise<void> | null };
const passiveItems = new Set(["userMessage", "agentMessage", "reasoning", "plan"]);
function assertPassive(items: { type: string }[]) {
  if (items.some(item => !passiveItems.has(item.type)))
    throw new AgentHubError("AGENT_AUTH", 403);
}
function nativeText(items: { type: string; text?: string; phase?: string | null }[]) {
  assertPassive(items);
  const messages = items.filter(i => i.type === "agentMessage");
  const final = messages.filter(i => i.phase === "final_answer");
  return (final.length ? final : messages).map(i => i.text ?? "").join("");
}
export class CodexChatBridge {
  private active = new Map<string, { threadId: string; turnId: string }>();
  private cancellations = new Map<
    string,
    Cancellation
  >();
  constructor(
    private rpc: CodexRpc,
    private journal: AgentHubState,
    private snapshots: string,
  ) {}
  async initialize() {
    await this.rpc.call("initialize", {
      clientInfo: {
        name: "strata_studio_runner",
        title: "Strata Studio runner",
        version: "1",
      },
      capabilities: { experimentalApi: true },
    });
    if (this.rpc instanceof CodexProcess) this.rpc.notifyInitialized();
  }
  async account() {
    return this.rpc.call("account/read", { refreshToken: false });
  }
  async models(): Promise<string[]> {
    const models = new Set<string>(), cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { data: { model: string; hidden?: boolean; inputModalities?: string[] }[]; nextCursor: string | null } = bounded(z.object({
        data: z.array(z.object({ model: z.string().regex(/^[@A-Za-z0-9_.:/-]{1,256}$/),
          hidden: z.boolean().optional(), inputModalities: z.array(z.string()).optional(),
        }).passthrough()).max(256),
        nextCursor: z.string().min(1).max(1024).nullable(),
      }).passthrough(), await this.rpc.call("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }));
      for (const model of page.data)
        if (!model.hidden && (!model.inputModalities || model.inputModalities.includes("text"))) models.add(model.model);
      if (models.size > 256 || (page.nextCursor && cursors.has(page.nextCursor)) || cursors.size >= 16)
        throw new AgentHubError("AGENT_LIMIT");
      cursor = page.nextCursor;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models];
  }
  async login() {
    return this.rpc.call("account/login/start", { type: "chatgptDeviceCode" });
  }
  async cancel(taskId: string) {
    const cancellation = this.cancellations.get(taskId);
    if (cancellation) cancellation.requested = true;
    // Native completion can precede progress delivery and the terminal journal
    // write. There is no running turn to interrupt during that drain.
    if (cancellation?.terminal) return;
    const native = this.active.get(taskId);
    const saved = native
      ? null
      : await this.journal.transaction(async (tx) => {
          const raw = await tx.get("codex/" + taskId);
          return raw ? nativeRecord.parse(raw) : null;
        });
    // The server can still have a queued cancellation while output delivery is
    // pending. A terminal receipt must never trigger another native interrupt.
    if (saved?.output) return;
    const target =
      native ??
      (saved?.thread_id && saved.turn_id
        ? { threadId: saved.thread_id, turnId: saved.turn_id }
        : null);
    if (target) await this.interrupt(target, cancellation);
  }
  private async interrupt(target: { threadId: string; turnId: string }, cancellation?: Cancellation) {
    const interrupt = () => this.rpc.call("turn/interrupt", target).then(() => {}).catch(error => {
      // Completion may race an already issued interrupt. Only an exact observed
      // terminal event makes the native invalid-turn response harmless.
      if (cancellation?.terminal && error instanceof AgentHubError && error.code === "AGENT_INVALID") return;
      throw error;
    });
    if (cancellation) await (cancellation.interrupt ??= interrupt());
    else await interrupt();
  }
  async inspect(request: TurnRequest): Promise<TurnOutput | null> {
    const key = "codex/" + request.task_id,
      requestHash = digest(request),
      record = await this.journal.transaction(async (tx) => {
        const raw = await tx.get(key);
        return raw ? nativeRecord.parse(raw) : null;
      });
    if (!record) return null;
    if (record.request_sha256 !== requestHash)
      throw new AgentHubError("AGENT_STALE");
    if (record.output) return record.output;
    if (!record.thread_id || !record.turn_id) return null;
    const observed = bounded(
      z
        .object({
          thread: z
            .object({
              id: z.string(),
              turns: z
                .array(
                  z
                    .object({
                      id: z.string(),
                      status: z.string(),
                      items: z.array(
                        z
                          .object({
                            type: z.string(),
                            text: z.string().optional(),
                            phase: z.string().nullable().optional(),
                          })
                          .passthrough(),
                      ),
                    })
                    .passthrough(),
                )
                .max(128),
            })
            .passthrough(),
        })
        .passthrough(),
      await this.rpc.call("thread/read", {
        threadId: record.thread_id,
        includeTurns: true,
      }),
      262144,
    );
    if (observed.thread.id !== record.thread_id)
      throw new AgentHubError("AGENT_STALE");
    const turn = observed.thread.turns.find((t) => t.id === record.turn_id);
    if (!turn || !["completed", "interrupted", "failed"].includes(turn.status))
      return null;
    assertPassive(turn.items);
    const state =
        turn.status === "completed"
          ? "succeeded"
          : turn.status === "interrupted"
            ? "cancelled"
            : "failed",
      text = nativeText(turn.items);
    const proposal =
      state === "succeeded" && request.kind === "proposal"
        ? parseCodexProposal(text, request.limits.output_bytes)
        : null;
    if (
      proposal &&
      (proposal.context_sha256 !== request.context_sha256 ||
        proposal.baseline !== request.context.baseline)
    )
      throw new AgentHubError("AGENT_STALE");
    const output = bounded(
      turnOutputSchema,
      {
        format: "strata-agent-chat-output/1",
        task_id: request.task_id,
        request_sha256: requestHash,
        state,
        text: proposal ? proposal.intent : text,
        proposal,
        code: state === "succeeded" ? null : "AGENT_NATIVE_FAILED",
      },
      request.limits.output_bytes,
    );
    await this.journal.transaction(async (tx) => {
      const current = nativeRecord.parse(await tx.get(key));
      if (
        current.request_sha256 !== requestHash ||
        current.thread_id !== record.thread_id ||
        current.turn_id !== record.turn_id
      )
        throw new AgentHubError("AGENT_STALE");
      await tx.put(key, { ...current, state: "completed", output });
    });
    return output;
  }
  async run(
    request: TurnRequest,
    onText: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<TurnOutput> {
    if (signal.aborted) throw new AgentHubError("AGENT_STALE");
    const requestHash = digest(request),
      recordKey = "codex/" + request.task_id;
    if (this.cancellations.has(request.task_id))
      throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
    const cancellation = { requested: false, terminal: false, interrupt: null as Promise<void> | null };
    this.cancellations.set(request.task_id, cancellation);
    let reserved = false,
      expectedTurn: string | null = null,
      fullText = "",
      pendingText = "",
      textWork = Promise.resolve(),
      unsubscribe = () => {},
      earlyEvents: { method: string; raw: any }[] = [],
      earlyBytes = 0,
      settle!: (value: any) => void,
      reject!: (error: unknown) => void;
    const finished = new Promise<any>((ok, no) => {
      settle = ok;
      reject = no;
    });
    finished.catch(() => {});
    const flushText = () => {
      if (!pendingText) return;
      const delta = pendingText;
      pendingText = "";
      textWork = textWork.then(() => onText(delta));
      textWork.catch(reject);
    };
    const checkSignal = () => {
      if (signal.aborted) throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
    };
    const checkStart = () => {
      checkSignal();
      if (cancellation.requested)
        throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
    };
    const abort = () => {
      void this.cancel(request.task_id).catch(() => {});
      reject(new AgentHubError("AGENT_RECOVERY_REQUIRED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const old = await this.journal.transaction(async (tx) => {
        const prior = await tx.get(recordKey);
        if (prior) return nativeRecord.parse(prior);
        await tx.put(recordKey, {
          request_sha256: requestHash,
          thread_id: null,
          turn_id: null,
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
      reserved = true;
      checkStart();
      const directory = path.join(this.snapshots, request.task_id);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        path.join(directory, "context.json"),
        JSON.stringify(request.context),
        { mode: 0o600, flag: "wx" },
      );
      checkStart();
      // Use a fresh task-scoped name and exact path entries. No built-in parent,
      // broad :minimal grant, profile-defined roots or persistent native config.
      const permission = codexTurnProfile(request.task_id, directory);
      const thread = bounded(
        z
          .object({
            thread: z.object({ id: z.string().min(1).max(256) }).passthrough(),
            model: z.string(),
            cwd: z.string(),
            approvalPolicy: z.literal("never"),
            runtimeWorkspaceRoots: z.array(z.string()).max(1),
            activePermissionProfile: z.object({ id: z.string(), extends: z.null() }).strict(),
          })
          .passthrough(),
        await this.rpc.call("thread/start", {
          model: request.model,
          cwd: directory,
          approvalPolicy: "never",
          permissions: permission.id,
          runtimeWorkspaceRoots: [directory],
          ephemeral: false,
          config: {
            default_permissions: permission.id,
            permissions: { [permission.id]: permission.profile },
            "windows.sandbox": "mxc",
            "features.shell_tool": false,
            web_search: "disabled",
            mcp_servers: {},
          },
          baseInstructions:
            "Only the supplied Strata intent context and conversation are authorized. Do not use shell, file editing, web search or MCP tools. Do not claim execution evidence or approvals.",
        }),
      );
      await this.journal.transaction(async (tx) => {
        await tx.put(recordKey, {
          request_sha256: requestHash,
          thread_id: thread.thread.id,
          turn_id: null,
          state: "reserved",
          output: null,
        });
      });
      if (thread.model !== request.model || path.resolve(thread.cwd) !== directory ||
          thread.runtimeWorkspaceRoots.length !== 1 ||
          path.resolve(thread.runtimeWorkspaceRoots[0]) !== directory ||
          thread.activePermissionProfile.id !== permission.id)
        throw new AgentHubError("AGENT_AUTH", 403);
      checkStart();
      const receive = (method: string, raw: any) => {
        if (signal.aborted) return;
        const p = raw as any;
        if (method === "runner/disconnected") {
          reject(new AgentHubError("AGENT_RECOVERY_REQUIRED"));
          return;
        }
        if (p?.threadId !== thread.thread.id) return;
        if (!expectedTurn) {
          earlyBytes += Buffer.byteLength(JSON.stringify(raw) ?? "");
          if (earlyEvents.length >= 256 || earlyBytes > 128 * 1024) {
            reject(new AgentHubError("AGENT_LIMIT"));
            void this.cancel(request.task_id).catch(() => {});
          } else earlyEvents.push({ method, raw });
          return;
        }
        if ((p.turnId ?? p.turn?.id) !== expectedTurn) return;
        if (method === "item/agentMessage/delta") {
          if (expectedTurn && p.turnId !== expectedTurn) return;
          const delta = String(p.delta ?? "");
          fullText += delta;
          if (Buffer.byteLength(fullText) > request.limits.output_bytes) {
            reject(new AgentHubError("AGENT_LIMIT"));
            void this.cancel(request.task_id).catch(() => {});
            return;
          }
          // A <=64 KiB output must not consume the hub's 255-event budget
          // through token-sized updates. The terminal remainder is flushed below.
          pendingText += delta;
          if (pendingText.length >= 1024) flushText();
        }
        if (
          method === "item/started" &&
          !passiveItems.has(p.item?.type)
        ) {
          reject(new AgentHubError("AGENT_AUTH", 403));
          void this.cancel(request.task_id).catch(() => {});
        }
        if (
          method === "turn/completed" &&
          (!expectedTurn || p.turn?.id === expectedTurn)
        ) {
          cancellation.terminal = ["completed", "interrupted", "failed"].includes(p.turn.status);
          settle(p.turn);
        }
        if (method === "runner/disconnected")
          reject(new AgentHubError("AGENT_RECOVERY_REQUIRED"));
      };
      unsubscribe = this.rpc.onEvent(receive);
      const prompt = JSON.stringify({
        kind: request.kind,
        context: request.context,
        context_sha256: request.context_sha256,
        messages: request.messages,
        proposal_format:
          request.kind === "proposal" ? codexProposalOutputSchema() : null,
      });
      checkStart();
      const turn = bounded(
        nativeTurnReply,
        await this.rpc.call("turn/start", {
          threadId: thread.thread.id,
          input: [{ type: "text", text: prompt }],
          model: request.model,
          approvalPolicy: "never",
          permissions: permission.id,
          runtimeWorkspaceRoots: [directory],
          ...(request.kind === "proposal"
            ? { outputSchema: codexProposalOutputSchema() }
            : {}),
        }, async (raw) => {
          // A timed-out RPC may still deliver its original admission receipt.
          // It cannot produce success or a new turn; retain its ID and stop it.
          const late = bounded(nativeTurnReply, raw);
          const stopping = this.interrupt({ threadId: thread.thread.id, turnId: late.turn.id }, cancellation).catch(() => {});
          try {
            await this.journal.transaction(async (tx) => {
              const current = nativeRecord.parse(await tx.get(recordKey));
              if (current.request_sha256 !== requestHash || current.thread_id !== thread.thread.id ||
                  (current.turn_id && current.turn_id !== late.turn.id)) throw new AgentHubError("AGENT_STALE");
              if (!current.output) await tx.put(recordKey, { ...current, turn_id: late.turn.id, state: "uncertain" });
            });
          } finally { await stopping; }
        }),
      );
      expectedTurn = turn.turn.id;
      this.active.set(request.task_id, {
        threadId: thread.thread.id,
        turnId: turn.turn.id,
      });
      for (const event of earlyEvents) receive(event.method, event.raw);
      earlyEvents = [];
      // A cancellation received during admission has no native ID until now.
      // Interrupt that original turn immediately, retaining its IDs for recovery.
      if (cancellation.requested || signal.aborted)
        void this.cancel(request.task_id).catch(() => {});
      await this.journal.transaction(async (tx) => {
        await tx.put(recordKey, {
          request_sha256: requestHash,
          thread_id: thread.thread.id,
          turn_id: turn.turn.id,
          state: "running",
          output: null,
        });
      });
      checkSignal();
      const completed = await finished;
      flushText();
      await textWork;
      checkSignal();
      const state =
        completed.status === "completed"
          ? "succeeded"
          : completed.status === "interrupted"
            ? "cancelled"
            : "failed";
      const completedText = nativeText(completed.items ?? []);
      if (completedText) fullText = completedText;
      const proposal =
        state === "succeeded" && request.kind === "proposal"
          ? parseCodexProposal(fullText, request.limits.output_bytes)
          : null;
      const output = bounded(
        turnOutputSchema,
        {
          format: "strata-agent-chat-output/1",
          task_id: request.task_id,
          request_sha256: requestHash,
          state,
          text: proposal ? proposal.intent : fullText,
          proposal,
          code: state === "succeeded" ? null : "AGENT_NATIVE_FAILED",
        },
        request.limits.output_bytes,
      );
      if (
        proposal &&
        (proposal.context_sha256 !== request.context_sha256 ||
          proposal.baseline !== request.context.baseline)
      )
        throw new AgentHubError("AGENT_STALE");
      await this.journal.transaction(async (tx) => {
        checkSignal();
        tx.beforeCommit?.(checkSignal);
        await tx.put(recordKey, {
          request_sha256: requestHash,
          thread_id: thread.thread.id,
          turn_id: turn.turn.id,
          state: "completed",
          output,
        });
      });
      return output;
    } catch (error) {
      if (!reserved) throw error;
      await this.journal
        .transaction(async (tx) => {
          const current = nativeRecord.parse(await tx.get(recordKey));
          await tx.put(recordKey, { ...current, state: "uncertain" });
        })
        .catch(() => {});
      throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", abort);
      this.active.delete(request.task_id);
      this.cancellations.delete(request.task_id);
    }
  }
}
