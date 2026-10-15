import { readFile } from "node:fs/promises";
import {
  generateKeyPairSync,
  createHash,
  createPublicKey,
  verify,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import { digest } from "../model.js";
import {
  AgentHubError,
  bounded,
  turnOutputSchema,
  type AgentConnection,
  type TurnRequest,
  type AgentTurn,
} from "./protocol.js";
import {
  deploymentSchema,
  type AgentProvisioner,
  type AgentDeployment,
  type AgentRuntime,
  type AgentAuthority,
  type AgentRuntimeControl,
} from "./hub.js";
import { AgentVault } from "./vault.js";

export const WORKERS_AI_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
] as const;
export async function boundedResponse(response: Response, maximum = 98304) {
  if (
    !response.ok ||
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  )
    throw new AgentHubError("AGENT_RUNTIME_OFFLINE", 503);
  const reader = response.body?.getReader();
  if (!reader) throw new AgentHubError("AGENT_INVALID");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new AgentHubError("AGENT_LIMIT", 413);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"),
    );
  } catch {
    throw new AgentHubError("AGENT_INVALID");
  }
}
const byteDigest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const envelope = z
  .object({ payload: z.unknown(), signature: z.string().max(256) })
  .strict();
export class CloudflareChatRuntime implements AgentRuntime {
  constructor(
    private vault: AgentVault,
    private transport: typeof fetch = fetch,
  ) {}
  private async call(
    connection: AgentConnection,
    path: string,
    method: string,
    body?: unknown,
    control?: AgentRuntimeControl,
  ) {
    if (!control) throw new AgentHubError("AGENT_AUTH", 403);
    await control.refresh();
    control.assertLive();
    if (
      !connection.service_url ||
      !connection.service_public_key ||
      !connection.credential_id
    )
      throw new AgentHubError("AGENT_UNCONFIGURED");
    const base = new URL(connection.service_url);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== "/"
    )
      throw new AgentHubError("AGENT_AUTH", 403);
    return this.vault.use(connection.credential_id, async (secret) => {
      await control.refresh();
      control.assertLive();
      const response = await this.transport(base.origin + path, {
        method,
        redirect: "error",
        headers: {
          authorization: "Bearer " + secret,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([control.signal, AbortSignal.timeout(10000)]),
      });
      const signed = bounded(envelope, await boundedResponse(response), 98304);
      await control.refresh();
      control.assertLive();
      if (
        !verify(
          null,
          Buffer.from(JSON.stringify(signed.payload)),
          createPublicKey({
            key: Buffer.from(connection.service_public_key!, "base64url"),
            format: "der",
            type: "spki",
          }),
          Buffer.from(signed.signature, "base64url"),
        )
      )
        throw new AgentHubError("AGENT_AUTH", 403);
      return signed.payload;
    });
  }
  async start(
    c: AgentConnection,
    request: TurnRequest,
    control: AgentRuntimeControl,
  ) {
    const result = await this.call(c, "/turns", "POST", request, control);
    const r = z
      .object({
        task_id: z.string().uuid(),
        request_sha256: z.string(),
        state: z.enum([
          "queued",
          "running",
          "succeeded",
          "failed",
          "cancelled",
          "interrupted",
        ]),
      })
      .strict()
      .parse(result);
    if (r.task_id !== request.task_id || r.request_sha256 !== digest(request))
      throw new AgentHubError("AGENT_STALE");
  }
  async inspect(
    c: AgentConnection,
    t: AgentTurn,
    control: AgentRuntimeControl,
  ) {
    const r = await this.call(c, "/turns/" + t.id, "GET", undefined, control);
    const p = z
      .object({
        task_id: z.string().uuid(),
        request_sha256: z.string(),
        state: z.enum([
          "queued",
          "running",
          "succeeded",
          "failed",
          "cancel_requested",
          "cancelled",
          "interrupted",
        ]),
        output: turnOutputSchema.nullable(),
        text: z.string().max(65536).optional(),
      })
      .strict()
      .parse(r);
    if (p.task_id !== t.id || p.request_sha256 !== t.request_sha256)
      throw new AgentHubError("AGENT_STALE");
    return {
      state: p.state,
      output: p.output ?? undefined,
      events: p.text ? [p.text] : undefined,
    };
  }
  async cancel(c: AgentConnection, t: AgentTurn, control: AgentRuntimeControl) {
    await this.call(c, "/turns/" + t.id + "/cancel", "POST", {}, control);
  }
}
/** Explicit browser-approved provisioning. Constructor and preview never use a provider. */
export class CloudflareAgentProvisioner implements AgentProvisioner {
  constructor(
    private vault: AgentVault,
    private bundleFile: string,
    private transport: typeof fetch = fetch,
  ) {}
  async preview(
    input: Parameters<AgentProvisioner["preview"]>[0],
  ): Promise<AgentDeployment> {
    if (!(WORKERS_AI_MODELS as readonly string[]).includes(input.model))
      throw new AgentHubError("AGENT_MODEL_UNSUPPORTED", 422);
    const bytes = await readFile(this.bundleFile);
    if (bytes.length > 3 * 1024 * 1024) throw new AgentHubError("AGENT_LIMIT");
    const packet = {
      ...input,
      bundle_sha256: byteDigest(bytes),
      service_public_key: "",
      runtime_credential_id: randomUUID(),
      identity_secret_id: randomUUID(),
      permissions: [
        "Account: Workers Scripts Write",
        "Account: Account Settings Read",
      ],
      resources: [
        "Dedicated Worker: " + input.script_name,
        "Agent Durable Object namespace",
        "Workers AI binding",
      ],
      created_at: new Date().toISOString(),
    };
    const keys = generateKeyPairSync("ed25519");
    packet.service_public_key = Buffer.from(
      keys.publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64url");
    await this.vault.save(
      packet.identity_secret_id,
      Buffer.from(
        keys.privateKey.export({ format: "der", type: "pkcs8" }),
      ).toString("base64url"),
    );
    await this.vault.save(
      packet.runtime_credential_id,
      Buffer.from(randomBytes(32)).toString("base64url"),
    );
    return deploymentSchema.parse({ ...packet, sha256: digest(packet) });
  }
  async inspect(preview: AgentDeployment, authority: AgentAuthority) {
    return this.vault.use(preview.credential_id, async (token) => {
      await authority.refresh();
      const response = await this.transport(
        "https://api.cloudflare.com/client/v4/accounts/" +
          preview.account_id +
          "/workers/subdomain",
        {
          redirect: "error",
          headers: { authorization: "Bearer " + token },
          signal: AbortSignal.timeout(10000),
        },
      );
      const result = z
        .object({
          success: z.literal(true),
          result: z
            .object({ subdomain: z.string().regex(/^[a-z0-9-]{1,63}$/) })
            .passthrough(),
        })
        .passthrough()
        .parse(await boundedResponse(response));
      const service_url =
        "https://" +
        preview.script_name +
        "." +
        result.result.subdomain +
        ".workers.dev/";
      return this.vault.use(
        preview.runtime_credential_id,
        async (runtimeToken) => {
          await authority.refresh();
          const identity = await this.transport(service_url + "identity", {
              redirect: "error",
              headers: { authorization: "Bearer " + runtimeToken },
              signal: AbortSignal.timeout(10000),
            }),
            signed = bounded(envelope, await boundedResponse(identity));
          if (
            !verify(
              null,
              Buffer.from(JSON.stringify(signed.payload)),
              createPublicKey({
                key: Buffer.from(preview.service_public_key, "base64url"),
                format: "der",
                type: "spki",
              }),
              Buffer.from(signed.signature, "base64url"),
            )
          )
            throw new AgentHubError("AGENT_AUTH", 403);
          const proof = z
            .object({
              service_id: z.string().uuid(),
              model: z.string(),
              bundle_sha256: z.string(),
              initialized: z.boolean(),
            })
            .strict()
            .parse(signed.payload);
          if (
            proof.service_id !== preview.id ||
            proof.model !== preview.model ||
            proof.bundle_sha256 !== preview.bundle_sha256
          )
            throw new AgentHubError("AGENT_STALE");
          await authority.refresh();
          return {
            initialized: proof.initialized,
            target: {
              service_url,
              service_public_key: preview.service_public_key,
              credential_id: preview.runtime_credential_id,
            },
          };
        },
      );
    });
  }
  async deploy(preview: AgentDeployment, authority: AgentAuthority) {
    const bundle = await readFile(this.bundleFile);
    if (byteDigest(bundle) !== preview.bundle_sha256)
      throw new AgentHubError("AGENT_STALE");
    const publicKey = createPublicKey({
      key: Buffer.from(preview.service_public_key, "base64url"),
      format: "der",
      type: "spki",
    });
    const private_key = await this.vault.use(
        preview.identity_secret_id,
        async (value) => value,
      ),
      runtimeToken = await this.vault.use(
        preview.runtime_credential_id,
        async (value) => value,
      );
    return this.vault.use(preview.credential_id, async (apiToken) => {
      const base =
        "https://api.cloudflare.com/client/v4/accounts/" +
        preview.account_id +
        "/workers";
      const call = async (path: string, method = "GET", body?: BodyInit) => {
        await authority.refresh();
        authority.assertLive();
        const response = await this.transport(base + path, {
          method,
          redirect: "error",
          headers: {
            authorization: "Bearer " + apiToken,
            ...(body instanceof FormData
              ? {}
              : { "content-type": "application/json" }),
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
        const result = z
          .object({ success: z.boolean(), result: z.unknown() })
          .passthrough()
          .parse(await boundedResponse(response));
        await authority.refresh();
        if (!result.success) throw new AgentHubError("AGENT_AUTH", 403);
        return result.result;
      };
      const subdomain = z
        .object({ subdomain: z.string().regex(/^[a-z0-9-]{1,63}$/) })
        .passthrough()
        .parse(await call("/subdomain"));
      const metadata = {
        main_module: "worker.mjs",
        compatibility_date: "2026-10-08",
        compatibility_flags: ["nodejs_compat"],
        bindings: [
          {
            type: "durable_object_namespace",
            name: "AGENT",
            class_name: "StudioAgent",
          },
          { type: "ai", name: "AI" },
          { type: "plain_text", name: "MODEL", text: preview.model },
          { type: "plain_text", name: "SERVICE_ID", text: preview.id },
          {
            type: "plain_text",
            name: "BUNDLE_SHA256",
            text: preview.bundle_sha256,
          },
          { type: "secret_text", name: "RUNTIME_TOKEN", text: runtimeToken },
          {
            type: "secret_text",
            name: "IDENTITY_PRIVATE_KEY",
            text: private_key,
          },
        ],
        migrations: {
          new_tag: "v1",
          steps: [{ new_sqlite_classes: ["StudioAgent"] }],
        },
        observability: { enabled: true, traces: { enabled: true } },
      };
      const form = new FormData();
      form.set("metadata", JSON.stringify(metadata));
      form.set(
        "worker.mjs",
        new Blob([new Uint8Array(bundle)], {
          type: "application/javascript+module",
        }),
        "worker.mjs",
      );
      await call("/scripts/" + preview.script_name, "PUT", form);
      await call(
        "/scripts/" + preview.script_name + "/subdomain",
        "POST",
        JSON.stringify({ enabled: true, previews_enabled: false }),
      );
      const service_url =
        "https://" +
        preview.script_name +
        "." +
        subdomain.subdomain +
        ".workers.dev/";
      await authority.refresh();
      authority.assertLive();
      const init = await this.transport(service_url + "initialize", {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: "Bearer " + runtimeToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ service_id: preview.id }),
        signal: AbortSignal.timeout(10000),
      });
      const proof = bounded(envelope, await boundedResponse(init));
      if (
        !verify(
          null,
          Buffer.from(JSON.stringify(proof.payload)),
          publicKey,
          Buffer.from(proof.signature, "base64url"),
        )
      )
        throw new AgentHubError("AGENT_AUTH", 403);
      const initialized = z
        .object({
          service_id: z.literal(preview.id),
          initialized: z.literal(true),
        })
        .strict()
        .safeParse(proof.payload);
      if (!initialized.success) throw new AgentHubError("AGENT_STALE");
      await authority.refresh();
      return {
        service_url,
        service_public_key: preview.service_public_key,
        credential_id: preview.runtime_credential_id,
      };
    });
  }
}
