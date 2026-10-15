import path from "node:path";
import { readFile, mkdir, lstat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentHubState } from "../src/studio-agents/state.js";
import { AgentVault } from "../src/studio-agents/vault.js";
import {
  CodexProcess,
  CodexChatBridge,
  CODEX_QUALIFICATION_VERSION,
  CODEX_SCHEMA_PIN,
} from "../src/studio-agents/codex.js";
import {
  ClaudeChatBridge,
  CLAUDE_SDK_VERSION,
  type ClaudeSdkPort,
} from "../src/studio-agents/claude.js";
import {
  turnRequestSchema,
  runnerPacketSchema,
  bounded,
  type TurnRequest,
  type TurnOutput,
} from "../src/studio-agents/protocol.js";
import { boundedResponse } from "../src/studio-agents/cloudflare.js";
import {
  privateDir,
  readPrivate,
  writePrivate,
  withLease,
} from "../src/explorer/owner-files.js";
import { noLinks } from "../src/node-state.js";
import { assertAgentWindowsCustody } from "../src/studio-agents/windows-custody.js";
const argv = process.argv.slice(2),
  get = (name: string) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
export class RunnerSetupError extends Error {}
export function studioOrigin(value: string) {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password ||
      origin.search || origin.hash || origin.pathname !== "/")
    throw new RunnerSetupError("Use the exact approved HTTPS Studio origin.");
  return origin.origin;
}
export async function assertUnpaired(directory: string) {
  for (const name of ["runner.json", "pairing-pending.json"])
    try {
      await lstat(path.join(directory, name));
      throw new RunnerSetupError("Existing or unresolved pairing found. Start the existing runner or reconcile its original Studio receipt; do not pair over it.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
}
const configSchema = z
  .object({
    format: z.literal("strata-studio-runner/1"),
    origin: z.string().url(),
    runner_id: z.string().uuid(),
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    runtime: z.enum(["codex", "claude"]).default("codex"),
    binary: z.string().nullable(),
    binary_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    binary_schema_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    credential_id: z.string().uuid().nullable(),
    installation_id: z.string().uuid(),
    owner_id: z.string().uuid(),
  })
  .strict();
async function stdin(maximum: number) {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > maximum)
      throw new Error("Attended input exceeds its bound.");
  }
  return text.trim();
}
async function nativeProbe(binary: string, args: string[], cwd: string) {
  await noLinks(binary);
  return new Promise<string>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"])
      if (process.env[name]) env[name] = process.env[name];
    env.CODEX_HOME = path.join(cwd, "codex-home");
    env.HOME = cwd;
    env.USERPROFILE = cwd;
    const child = spawn(binary, args, {
      cwd, env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let text = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Version check timed out."));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      text += String(chunk);
      if (text.length > 1024) {
        child.kill();
        reject(Error("Invalid runtime version."));
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(Error("Runtime version unavailable."));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(text.trim());
      else reject(new RunnerSetupError("Runtime version check failed."));
    });
  });
}
export const CODEX_SCHEMA_FILES = ["ThreadStartParams", "TurnStartParams", "ThreadStartResponse"] as const;
export function assertCodexPermissionSchemas(schemas: Record<string, any>) {
  const variants = (schema: any, node: any, depth = 0): any[] => {
    if (!node || depth > 16) return [];
    if (node.$ref) {
      if (!node.$ref.startsWith("#/")) return [];
      const target = node.$ref.slice(2).split("/").reduce((v: any, key: string) => v?.[key], schema);
      return variants(schema, target, depth + 1);
    }
    const alternatives = node.oneOf ?? node.anyOf ?? node.allOf;
    return alternatives ? alternatives.flatMap((n: any) => variants(schema, n, depth + 1)) : [node];
  };
  const isType = (node: any, type: string) => node?.type === type || (Array.isArray(node?.type) && node.type.includes(type));
  const has = (schema: any, node: any, type: string) => variants(schema, node).some(n => isType(n, type));
  for (const name of ["ThreadStartParams", "TurnStartParams"]) {
    const schema = schemas[name], properties = schema?.properties;
    const roots = variants(schema, properties?.runtimeWorkspaceRoots).find(n => isType(n, "array"));
    if (!has(schema, properties?.permissions, "string") || !has(schema, roots?.items, "string"))
      throw new RunnerSetupError("Generate the pinned Codex schemas with --experimental; named permissions and runtime workspace roots are required.");
  }
  const reply = schemas.ThreadStartResponse;
  const active = variants(reply, reply?.properties?.activePermissionProfile).find(n => isType(n, "object"));
  const replyRoots = variants(reply, reply?.properties?.runtimeWorkspaceRoots).find(n => isType(n, "array"));
  if (!has(reply, active?.properties?.id, "string") || !active?.properties?.extends ||
      !has(reply, replyRoots?.items, "string"))
    throw new RunnerSetupError("Native schema lacks named-profile readback. No compatibility fallback is permitted.");
}
export async function checkCodexBinary(binary: string, probeNative = nativeProbe) {
  if (!path.isAbsolute(binary) || /\.(ps1|cmd|bat)$/i.test(binary))
    throw new RunnerSetupError("Supply an absolute native Codex executable path.");
  const probe = await mkdtemp(path.join(tmpdir(), "strata-codex-probe-"));
  const version = (await probeNative(binary, ["--version"], probe)).replace(/^codex-cli /, "");
  if (version !== CODEX_QUALIFICATION_VERSION)
    throw new RunnerSetupError("Codex " + CODEX_QUALIFICATION_VERSION + " is required. Your installed CLI was preserved. Use a separately reviewed native binary; no automatic upgrade is performed.");
  const out = path.join(probe, "schemas");
  await probeNative(binary, ["app-server", "generate-json-schema", "--experimental", "--out", out], probe);
  const schemas: Record<string, unknown> = {}, hashes: Record<string, string> = {};
  for (const name of CODEX_SCHEMA_FILES) {
    const bytes = await readFile(path.join(out, "v2", name + ".json"));
    if (bytes.length > 1024 * 1024) throw new RunnerSetupError("Native schema exceeds its bound.");
    schemas[name] = JSON.parse(new TextDecoder().decode(bytes));
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
  assertCodexPermissionSchemas(schemas);
  return { version, binary_sha256: createHash("sha256").update(await readFile(binary)).digest("hex"),
    binary_schema_sha256: createHash("sha256").update(JSON.stringify(hashes)).digest("hex") };
}
async function claudeSdk() {
  const packageName = "@anthropic-ai/claude-agent-sdk",
    entry = fileURLToPath(import.meta.resolve(packageName));
  let root = path.dirname(entry),
    manifest: any;
  for (let i = 0; i < 3; i++) {
    try {
      const p = JSON.parse(
        await readFile(path.join(root, "package.json"), "utf8"),
      );
      if (p.name === packageName) {
        manifest = p;
        break;
      }
    } catch {}
    root = path.dirname(root);
  }
  if (
    manifest?.version !== CLAUDE_SDK_VERSION ||
    manifest?.claudeCodeVersion !== "2.1.296"
  )
    throw Error("Install the separately reviewed Claude SDK/runtime pair.");
  const module = await import(packageName);
  return { version: manifest.version, query: module.query } as ClaudeSdkPort;
}
interface Bridge {
  inspect(request: TurnRequest): Promise<TurnOutput | null>;
  run(
    request: TurnRequest,
    onText: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<TurnOutput>;
  cancel(taskId: string): Promise<void>;
}
export async function applyRunnerControls(
  bridge: Pick<Bridge, "inspect" | "cancel">,
  packet: z.infer<typeof runnerPacketSchema>,
  deliver: (output: TurnOutput) => Promise<unknown>,
) {
  let recoveredTask: string | null = null;
  // An original turn may already be terminal and unloaded after restart.
  // Recover that result before attempting a redundant native interrupt.
  if (packet.inspect) {
    const request = turnRequestSchema.parse(packet.inspect);
    const output = await bridge.inspect(request);
    if (output) {
      await deliver(output);
      recoveredTask = request.task_id;
    }
  }
  for (const id of packet.cancel)
    if (id !== recoveredTask) await bridge.cancel(id);
}
async function main() {
  if (argv.includes("--help")) {
    process.stdout.write(
      "Strata Studio local agent runner\nOffline Codex preflight: --check-codex --codex-bin ABS\nPair: --state-dir ABS --origin HTTPS --pairing-id UUID --runtime codex|claude [--codex-bin ABS] --code-stdin\nInitialize: --state-dir ABS --initialize\nClaude key: --state-dir ABS --save-api-key --key-stdin\nRun: --state-dir ABS\nSecrets arrive on attended stdin and stay on the agent machine.\n",
    );
    return;
  }
  if (argv.includes("--check-codex")) {
    const checked = await checkCodexBinary(get("--codex-bin") ?? "");
    process.stdout.write(JSON.stringify({ ...checked, schema_pin: CODEX_SCHEMA_PIN, schema_mode: "experimental-named-permissions", sandbox: "mxc", native_qualified: false }) + "\n");
    return;
  }
  const directory = get("--state-dir");
  if (!directory || !path.isAbsolute(directory))
    throw Error("Supply an absolute private state directory.");
  const configFile = path.join(directory, "runner.json");
  if (get("--pairing-id")) {
    const origin = studioOrigin(get("--origin") ?? "");
    z.string().uuid().parse(get("--pairing-id"));
    const runtime = z
        .enum(["codex", "claude"])
        .parse(get("--runtime") ?? "codex"),
      binary = runtime === "codex" ? (get("--codex-bin") ?? null) : null;
    if (
      !argv.includes("--code-stdin") ||
      (runtime === "codex" &&
        (!binary ||
          !path.isAbsolute(binary) ||
          /\.(ps1|cmd|bat)$/i.test(binary)))
    )
      throw Error(
        "Supply the reviewed native binary and attended pairing input.",
      );
    await privateDir(directory, true);
    if (process.platform === "win32")
      await assertAgentWindowsCustody(directory);
    return withLease(directory, async () => {
    await assertUnpaired(directory);
    const checked = binary ? await checkCodexBinary(binary) : null;
    const version = checked?.version ?? (await claudeSdk()).version;
    const binary_sha256 = checked?.binary_sha256 ?? null;
    const binary_schema_sha256 = checked?.binary_schema_sha256 ?? null;
    const code = await stdin(256);
    await writePrivate(path.join(directory, "pairing-pending.json"), {
      pairing_id: get("--pairing-id"), origin, runtime,
    }, true);
    const paired = z
      .object({ runner_id: z.string().uuid(), token: configSchema.shape.token })
      .strict()
      .parse(
        await boundedResponse(
          await fetch(origin + "/studio/v1/agent-runners/pair", {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              pairing_id: get("--pairing-id"),
              code,
              label: get("--name") ?? "Local " + runtime,
              runtime,
              version,
            }),
            signal: AbortSignal.timeout(10000),
          }),
        ),
      );
    await writePrivate(
      configFile,
      {
        format: "strata-studio-runner/1",
        origin,
        runner_id: paired.runner_id,
        token: paired.token,
        runtime,
        binary,
        binary_sha256,
        binary_schema_sha256,
        credential_id: null,
        installation_id: randomUUID(),
        owner_id: randomUUID(),
      },
      true,
    );
    process.stdout.write("Runner paired. No model task was started.\n");
    return;
    });
  }
  const config = configSchema.parse(await readPrivate(configFile));
  await privateDir(directory);
  if (process.platform === "win32") await assertAgentWindowsCustody(directory);
  if (studioOrigin(config.origin) !== config.origin)
    throw new RunnerSetupError("Stored Studio origin is not canonical.");
  return withLease(directory, async () => {
  const vault = new AgentVault(
    path.join(directory, "vault"),
    path.join(directory, "api-key.bin"),
    process.platform === "win32"
      ? () => assertAgentWindowsCustody(directory)
      : undefined,
  );
  if (argv.includes("--save-api-key")) {
    if (config.runtime !== "claude" || !argv.includes("--key-stdin"))
      throw Error("This key slot belongs only to the Claude runner.");
    const value = await stdin(2048);
    if (!value) throw Error("API key required.");
    let missing = false;
    try {
      await lstat(path.join(directory, "api-key.bin"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      missing = true;
    }
    if (missing) await vault.provision();
    const credential_id = randomUUID();
    await vault.save(credential_id, value);
    await writePrivate(configFile, { ...config, credential_id });
    process.stdout.write("Native API key saved privately.\n");
    return;
  }
  const home = path.join(directory, config.runtime + "-home"),
    snapshots = path.join(directory, "snapshots");
  for (const p of [home, snapshots]) {
    await mkdir(p, { mode: 0o700 }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    await privateDir(p);
  }
  const journal = new AgentHubState(
    path.join(directory, "journal"),
    config.installation_id,
    config.owner_id,
    { assertWindowsCustody: assertAgentWindowsCustody },
  );
  if (argv.includes("--initialize")) {
    await journal.provision();
    process.stdout.write("Runner journal provisioned.\n");
    return;
  }
  if (!(await journal.initialized()))
    throw Error("Explicitly provision the runner journal before startup.");
  let bridge: Bridge,
    account: () => Promise<boolean>,
    models: (() => Promise<string[]>) | undefined,
    login: (() => Promise<unknown>) | undefined,
    close = () => {};
  if (config.runtime === "codex") {
    if (!config.binary || !config.binary_schema_sha256)
      throw new RunnerSetupError("This paired runner lacks a compatible native schema receipt. Reconcile its original installation after offline preflight; preserve its pairing and journal.");
    await noLinks(config.binary);
    if (createHash("sha256").update(await readFile(config.binary)).digest("hex") !== config.binary_sha256)
      throw new RunnerSetupError("Pinned Codex binary changed. It was not executed; reconcile the original installation.");
    const checked = await checkCodexBinary(config.binary);
    if (checked.binary_schema_sha256 !== config.binary_schema_sha256)
      throw new RunnerSetupError("Pinned Codex schema changed. No session was started.");
    const rpc = new CodexProcess(config.binary, home, snapshots),
      native = new CodexChatBridge(rpc, journal, snapshots);
    try { await native.initialize(); } catch (e) { rpc.close(); throw e; }
    bridge = native;
    account = async () =>
      !!((await native.account()) as { account?: unknown }).account;
    models = () => native.models();
    login = () => native.login();
    close = () => rpc.close();
  } else {
    const sdk = await claudeSdk();
    if (!config.credential_id)
      throw Error("Save the local API key through attended setup.");
    bridge = new ClaudeChatBridge(sdk, journal, snapshots, () =>
      vault.use(config.credential_id!, async (value) => value),
    );
    account = async () => true;
  }
  const post = async (route: string, value: unknown) =>
    boundedResponse(
      await fetch(
        config.origin +
          "/studio/v1/agent-runners/" +
          config.runner_id +
          "/" +
          route,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: "Bearer " + config.token,
            "content-type": "application/json",
          },
          body: JSON.stringify(value),
          signal: AbortSignal.timeout(10000),
        },
      ),
    );
  let stopped = false,
    failed = false;
  const active = new Map<string, Promise<void>>();
  let catalog: string[] = [], catalogAt = 0;
  process.on("SIGINT", () => {
    stopped = true;
    close();
  });
  process.on("SIGTERM", () => {
    stopped = true;
    close();
  });
  try {
    while (!stopped && !failed) {
      const ready = await account(),
        now = Date.now();
      if (!ready) { catalog = []; catalogAt = 0; }
      else if (models && now - catalogAt >= 30000) {
        catalog = await models(); catalogAt = now;
      }
      const packet = bounded(runnerPacketSchema, await post("poll", {
        ready, busy: active.size > 0, ...(models ? { models: catalog } : {}),
      }), 262144);
      if (packet.login_id && login) {
        const result = (await login()) as {
          verificationUrl?: string;
          userCode?: string;
        };
        if (result.verificationUrl && result.userCode)
          await post("login", {
            login_id: packet.login_id,
            verification_url: result.verificationUrl,
            user_code: result.userCode,
          });
      }
      await applyRunnerControls(bridge, packet, output => post("output", output));
      if (packet.task) {
        const request = turnRequestSchema.parse(packet.task);
        let text = "";
        const work = (async () => {
          // Recheck account availability before native admission; never switch models.
          if (models && !(await models()).includes(request.model)) return {
            format: "strata-agent-chat-output/1" as const,
            task_id: request.task_id, request_sha256: packet.request_sha256!,
            state: "failed" as const, text: "", proposal: null, code: "AGENT_MODEL_UNSUPPORTED",
          };
          return bridge.run(
            request,
            async (delta) => {
              text += delta;
              await post("progress", {
                task_id: request.task_id,
                request_sha256: packet.request_sha256,
                text,
              });
            },
            AbortSignal.timeout(request.limits.runtime_ms),
          );
        })()
          .then(async (output) => {
            await post("output", output);
          })
          .catch(() => {
            failed = true;
          })
          .finally(() => active.delete(request.task_id));
        active.set(request.task_id, work);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    for (const id of active.keys()) await bridge.cancel(id).catch(() => {});
    close();
  }
  });
}
if (process.argv[1]?.endsWith("studio-agent-runner.js"))
  main().catch((e) => {
    if (e instanceof RunnerSetupError) process.stderr.write(e.message + "\n");
    process.stderr.write(
      "Runner stopped safely. Inspect local configuration/journal and the original Studio receipt before restarting. Runtime mismatch, custody failure and unavailable authentication never fall back or resubmit.\n",
    );
    process.exitCode = 1;
  });
