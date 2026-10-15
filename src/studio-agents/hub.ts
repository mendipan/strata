import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { digest, normalizeSnapshot, BLOCK_MODEL } from "../model.js";
import { normalizeLayer } from "../core.js";
import { AgentHubState, list, read } from "./state.js";
import { AgentVault } from "./vault.js";
import type { CloudflareExecutionTransaction } from "../agent-adapters/cloudflare-execution-journal.js";
import {
  AgentHubError,
  bounded,
  contextDigest,
  contextSchema,
  connectionSchema,
  consentSchema,
  conversationSchema,
  turnSchema,
  turnRequestSchema,
  turnOutputSchema,
  proposalSchema,
  runnerSchema,
  ownerActionSchema,
  hash,
  uuid,
  type AgentContext,
  type AgentConnection,
  type AgentTurn,
  type TurnRequest,
  type TurnOutput,
} from "./protocol.js";

export interface AgentAuthority {
  owner_id: string;
  installation_id: string;
  authentication_generation: number;
  assertLive(): void;
  refresh(): Promise<void>;
}
export interface AgentProjectPort {
  inspectSave?(id: string): Promise<{
    committed: boolean;
    result: unknown;
    draft_sha256: string | null;
  }>;
  context(baseline: string): Promise<AgentContext>;
  save(
    draft: unknown,
    requestId: string,
    context: AgentContext,
  ): Promise<unknown>;
}
export interface AgentRuntimeControl {
  signal: AbortSignal;
  assertLive(): void;
  refresh(): Promise<void>;
}
export interface AgentRuntime {
  start(
    connection: AgentConnection,
    request: TurnRequest,
    control: AgentRuntimeControl,
  ): Promise<void>;
  inspect(
    connection: AgentConnection,
    turn: AgentTurn,
    control: AgentRuntimeControl,
  ): Promise<{
    state?: AgentTurn["state"];
    events?: string[];
    output?: TurnOutput;
  }>;
  cancel(
    connection: AgentConnection,
    turn: AgentTurn,
    control: AgentRuntimeControl,
  ): Promise<void>;
}
export const deploymentSchema = z
  .object({
    id: uuid,
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    credential_id: uuid,
    label: z.string().min(1).max(128),
    model: z.string().max(256),
    limits: connectionSchema.shape.limits,
    script_name: z.string().max(64),
    bundle_sha256: hash,
    service_public_key: z.string().max(256),
    runtime_credential_id: uuid,
    identity_secret_id: uuid,
    permissions: z.array(z.string().max(128)).max(16),
    resources: z.array(z.string().max(128)).max(8),
    sha256: hash,
    created_at: z.string().datetime(),
  })
  .strict();
export type AgentDeployment = z.infer<typeof deploymentSchema>;
export interface AgentProvisioner {
  preview(
    input: Omit<
      AgentDeployment,
      | "bundle_sha256"
      | "service_public_key"
      | "runtime_credential_id"
      | "identity_secret_id"
      | "permissions"
      | "resources"
      | "sha256"
      | "created_at"
    >,
  ): Promise<AgentDeployment>;
  deploy(
    preview: AgentDeployment,
    authority: AgentAuthority,
  ): Promise<
    Pick<
      AgentConnection,
      "service_url" | "service_public_key" | "credential_id"
    >
  >;
  inspect?(
    preview: AgentDeployment,
    authority: AgentAuthority,
  ): Promise<{
    initialized: boolean;
    target: Pick<
      AgentConnection,
      "service_url" | "service_public_key" | "credential_id"
    >;
  }>;
}
const receiptSchema = z
  .object({
    id: uuid,
    input_sha256: hash,
    authentication_generation: z.number().int().positive(),
    state: z.enum(["pending", "completed", "uncertain", "failed"]),
    request_metadata: z.record(z.string(), z.unknown()).optional(),
    result: z.unknown(),
    created_at: z.string().datetime(),
  })
  .strict();
const pairingSchema = z
  .object({
    id: uuid,
    code_sha256: hash,
    runtime: runnerSchema.shape.runtime,
    expires_at: z.string().datetime(),
    used: z.boolean(),
    authority_epoch: z.string().max(128),
  })
  .strict();
const credentialSchema = z
  .object({ id: uuid, created_at: z.string().datetime() })
  .strict();
const provenanceSchema = z
  .object({
    turn_id: uuid,
    proposal_sha256: hash,
    context_sha256: hash,
    provider: connectionSchema.shape.provider,
    model: connectionSchema.shape.model,
    draft_result: z.unknown(),
  })
  .strict();
const compare = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const stamp = () => new Date().toISOString();
const receiptKey = (id: string) => "receipt/" + id;

/** Installation-private hub. Input never supplies owner identity or source authority. */
export class StudioAgentHub {
  private epoch = 0;
  private waits = new Set<{
    connectionId: string;
    controller: AbortController;
  }>();
  private readonly bootId = randomUUID();
  private authorityEpoch() {
    return this.bootId + "/" + this.epoch;
  }
  constructor(
    readonly state: AgentHubState,
    readonly vault: AgentVault,
    private runtime: AgentRuntime,
    private provisioner?: AgentProvisioner,
    private now = Date.now,
    private dispatchFence?: (
      context: AgentContext,
      ownerGeneration: number,
    ) => Promise<void>,
  ) {}
  changed() {
    this.epoch++;
    for (const wait of this.waits) wait.controller.abort();
  }
  private invalidateConnection(id: string) {
    for (const wait of this.waits)
      if (wait.connectionId === id) wait.controller.abort();
  }
  private async runtimeCall<T>(
    authority: AgentAuthority,
    project: AgentProjectPort,
    connection: AgentConnection,
    context: AgentContext,
    epoch: number,
    consentGeneration: number,
    call: (control: AgentRuntimeControl) => Promise<T>,
  ): Promise<T> {
    this.guard(authority, epoch);
    const consent = await this.authorized(connection, context),
      wait = { connectionId: connection.id, controller: new AbortController() };
    if (consent.generation !== consentGeneration)
      throw new AgentHubError("AGENT_STALE");
    this.waits.add(wait);
    const assertLive = () => {
      this.guard(authority, epoch);
      if (wait.controller.signal.aborted)
        throw new AgentHubError("AGENT_STALE");
    };
    const control: AgentRuntimeControl = {
      signal: wait.controller.signal,
      assertLive,
      refresh: async () => {
        await authority.refresh();
        assertLive();
        const current = await this.source(project, context.baseline);
        if (contextDigest(current) !== contextDigest(context))
          throw new AgentHubError("AGENT_STALE");
        const target = await this.connection(connection.id),
          grant = await this.authorized(target, current);
        if (
          target.generation !== connection.generation ||
          grant.generation !== consentGeneration
        )
          throw new AgentHubError("AGENT_STALE");
        assertLive();
      },
    };
    try {
      await control.refresh();
      return await call(control);
    } finally {
      this.waits.delete(wait);
    }
  }
  private receiptMetadata(receipt: z.infer<typeof receiptSchema>) {
    const result = receipt.result as Record<string, unknown> | null;
    return {
      ...receipt,
      result:
        result && typeof result === "object"
          ? Object.fromEntries(
              Object.entries(result).filter(([key]) =>
                [
                  "id",
                  "turn_id",
                  "conversation_id",
                  "credential_id",
                  "runner_id",
                  "pairing_id",
                  "expires_at",
                  "requested",
                  "state",
                  "code",
                  "provider",
                  "model",
                  "generation",
                  "enabled",
                  "revoked",
                  "created_at",
                  "proposal_sha256",
                  "context_sha256",
                  "initialized",
                ].includes(key),
              ),
            )
          : null,
    };
  }
  private guardEpoch(epoch: number) {
    if (epoch !== this.epoch) throw new AgentHubError("AGENT_STALE");
  }
  private guard(authority: AgentAuthority, epoch: number) {
    authority.assertLive();
    if (
      authority.owner_id !== this.state.ownerId ||
      authority.installation_id !== this.state.installationId ||
      epoch !== this.epoch
    )
      throw new AgentHubError("AGENT_STALE", 403);
  }
  async status(authority: AgentAuthority) {
    this.guard(authority, this.epoch);
    const reconciliation_scope = {
      owner: digest({
        owner: this.state.ownerId,
        installation: this.state.installationId,
      }),
      state: digest(this.state.directory),
      authentication_generation: authority.authentication_generation,
    };
    if (!(await this.state.initialized()))
      return {
        format: "strata-studio-agent-connections/1",
        initialized: false,
        reconciliation_scope,
        connections: [],
        runners: [],
        credentials: [],
        providers: ["cloudflare", "codex", "claude"],
      };
    await this.vault.check();
    return this.state.transaction(async (tx) => ({
      format: "strata-studio-agent-connections/1",
      initialized: true,
      reconciliation_scope,
      connections: await list(tx, "connection/", connectionSchema, 32),
      runners: (await list(tx, "runner/", runnerSchema, 32)).map(
        ({ token_sha256, ...r }) => ({
          ...r,
          online: !r.revoked && this.now() - Date.parse(r.last_seen) < 45000,
        }),
      ),
      credentials: await list(tx, "credential/", credentialSchema, 16),
      deployments: await list(tx, "deployment/", deploymentSchema, 32),
      unresolved_operations: [
        ...(await tx.list({ prefix: "receipt/", limit: 1024 })).values(),
      ]
        .map((raw) => this.receiptMetadata(receiptSchema.parse(raw)))
        .filter((r) => ["pending", "uncertain"].includes(r.state)),
      providers: ["cloudflare", "codex", "claude"],
    }));
  }
  async outcome(authority: AgentAuthority, id: string) {
    this.guard(authority, this.epoch);
    uuid.parse(id);
    return this.state.transaction(async (tx) =>
      this.receiptMetadata(await read(tx, receiptKey(id), receiptSchema)),
    );
  }
  private async source(project: AgentProjectPort, baseline: string) {
    const c = bounded(contextSchema, await project.context(baseline), 65536);
    if (Buffer.byteLength(JSON.stringify(c.blocks)) > 32768)
      throw new AgentHubError("AGENT_LIMIT", 413);
    return c;
  }
  private async connection(id: string) {
    return this.state.transaction((tx) =>
      read(tx, "connection/" + id, connectionSchema),
    );
  }
  private async authorized(connection: AgentConnection, context: AgentContext) {
    if (!connection.enabled || connection.revoked)
      throw new AgentHubError("AGENT_AUTH", 403);
    return this.state.transaction(async (tx) => {
      const consent = await read(
        tx,
        "consent/" + connection.id + "/" + digest(context.binding),
        consentSchema,
      );
      if (
        consent.revoked_at ||
        digest(consent.binding) !== digest(context.binding)
      )
        throw new AgentHubError("AGENT_AUTH", 403);
      return consent;
    });
  }
  async action(
    authority: AgentAuthority,
    project: AgentProjectPort,
    input: unknown,
  ): Promise<{ replayed: boolean; result: unknown }> {
    const a = bounded(ownerActionSchema, input, 16384),
      epoch = this.epoch;
    const operationAuthority: AgentAuthority = {
      ...authority,
      assertLive: () => this.guard(authority, epoch),
      refresh: async () => {
        await authority.refresh();
        this.guard(authority, epoch);
      },
    };
    let actionStarted = false,
      hasEffect = false;
    const transaction = <T>(
      work: (tx: CloudflareExecutionTransaction) => Promise<T>,
    ): Promise<T> =>
      this.state.transaction(async (tx) => {
        tx.beforeCommit?.(() => this.guard(authority, epoch));
        const put = tx.put.bind(tx);
        let writes = false;
        const result = await work({
          ...tx,
          put: async (key, value) => {
            if (!key.startsWith("receipt/")) writes = true;
            await put(key, value);
          },
        });
        if (actionStarted && writes) hasEffect = true;
        return result;
      });
    await authority.refresh();
    this.guard(authority, epoch);
    if (a.action === "initialize") {
      if (await this.state.initialized())
        return { replayed: true, result: await this.status(authority) };
      await this.state.provision();
      await this.vault.provision();
      return { replayed: false, result: await this.status(authority) };
    }
    const inputHash = digest(a),
      replayed = await transaction(async (tx) => {
        const raw = await tx.get(receiptKey(a.request_id));
        if (raw) {
          const old = receiptSchema.parse(raw);
          if (
            old.input_sha256 !== inputHash ||
            old.authentication_generation !==
              authority.authentication_generation
          )
            throw new AgentHubError("AGENT_STALE");
          return old;
        }
        if ((await tx.list({ prefix: "receipt/", limit: 1024 })).size >= 1024)
          throw new AgentHubError("AGENT_LIMIT");
        this.guard(authority, epoch);
        tx.beforeCommit?.(() => this.guard(authority, epoch));
        await tx.put(receiptKey(a.request_id), {
          id: a.request_id,
          input_sha256: inputHash,
          authentication_generation: authority.authentication_generation,
          state: "pending",
          request_metadata: Object.fromEntries(
            Object.entries(a).filter(([key]) =>
              [
                "action",
                "connection_id",
                "conversation_id",
                "turn_id",
                "preview_id",
                "expected_sha256",
                "proposal_sha256",
                "layer_id",
                "source_request_id",
              ].includes(key),
            ),
          ),
          result: null,
          created_at: stamp(),
        });
        return null;
      });
    if (replayed) {
      if (replayed.state !== "completed")
        throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
      return { replayed: true, result: this.receiptMetadata(replayed).result };
    }
    actionStarted = true;
    try {
      let result: unknown;
      if (a.action === "pair") {
        const code = Buffer.from(randomBytes(24)).toString("base64url"),
          expires_at = new Date(this.now() + 10 * 60_000).toISOString();
        await transaction(async (tx) => {
          this.guard(authority, epoch);
          await tx.put("pair/" + a.request_id, {
            id: a.request_id,
            code_sha256: digest(code),
            runtime: a.runtime,
            expires_at,
            used: false,
            authority_epoch: this.authorityEpoch(),
          });
        });
        await this.complete(
          a.request_id,
          { pairing_id: a.request_id, expires_at, code: null },
          authority,
          epoch,
        );
        return {
          replayed: false,
          result: { pairing_id: a.request_id, expires_at, code },
        };
      } else if (a.action === "runner-login") {
        await transaction(async (tx) => {
          const r = await read(tx, "runner/" + a.runner_id, runnerSchema);
          if (r.revoked) throw new AgentHubError("AGENT_AUTH", 403);
          this.guard(authority, epoch);
          await tx.put("runner-login/" + r.id, {
            id: a.request_id,
            claimed: false,
            authority_epoch: this.authorityEpoch(),
          });
        });
        result = { runner_id: a.runner_id, requested: true };
      } else if (a.action === "credential") {
        hasEffect = true;
        await this.vault.save(a.request_id, a.value);
        await transaction(async (tx) => {
          this.guard(authority, epoch);
          await tx.put("credential/" + a.request_id, {
            id: a.request_id,
            created_at: stamp(),
          });
        });
        result = { credential_id: a.request_id };
      } else if (a.action === "add-runner") {
        result = await transaction(async (tx) => {
          const runner = await read(tx, "runner/" + a.runner_id, runnerSchema);
          if (runner.revoked) throw new AgentHubError("AGENT_AUTH", 403);
          if (runner.runtime === "codex") {
            if (!runner.ready || this.now() - Date.parse(runner.last_seen) >= 45000)
              throw new AgentHubError("AGENT_RUNTIME_OFFLINE", 503);
            if (!runner.models?.includes(a.model))
              throw new AgentHubError("AGENT_MODEL_UNSUPPORTED");
          }
          if (
            (await list(tx, "connection/", connectionSchema, 32)).length >= 32
          )
            throw new AgentHubError("AGENT_LIMIT");
          const connection = connectionSchema.parse({
            id: a.request_id,
            provider: runner.runtime,
            label: a.label,
            model: a.model,
            runner_id: runner.id,
            service_url: null,
            service_public_key: null,
            credential_id: null,
            generation: 1,
            enabled: true,
            revoked: false,
            created_at: stamp(),
            limits: a.limits,
          });
          this.guard(authority, epoch);
          await tx.put("connection/" + connection.id, connection);
          return connection;
        });
      } else if (a.action === "deployment-preview") {
        if (!this.provisioner)
          throw new AgentHubError("AGENT_UNCONFIGURED", 503);
        await transaction((tx) =>
          read(tx, "credential/" + a.credential_id, credentialSchema),
        );
        hasEffect = true;
        result = await this.provisioner.preview({
          id: a.request_id,
          account_id: a.account_id,
          credential_id: a.credential_id,
          label: a.label,
          model: a.model,
          limits: a.limits,
          script_name:
            "strata-agent-" +
            digest(this.state.installationId).slice(0, 12) +
            "-" +
            a.request_id.replaceAll("-", "").slice(0, 8),
        });
        await transaction(async (tx) => {
          this.guard(authority, epoch);
          await tx.put("deployment/" + a.request_id, result);
        });
      } else if (a.action === "deploy") {
        if (!this.provisioner)
          throw new AgentHubError("AGENT_UNCONFIGURED", 503);
        const preview = await transaction((tx) =>
          read(tx, "deployment/" + a.preview_id, deploymentSchema),
        );
        if (preview.sha256 !== a.expected_sha256)
          throw new AgentHubError("AGENT_STALE");
        hasEffect = true;
        const target = await this.provisioner.deploy(
          preview,
          operationAuthority,
        );
        await authority.refresh();
        this.guard(authority, epoch);
        result = connectionSchema.parse({
          id: a.request_id,
          provider: "cloudflare",
          label: preview.label,
          model: preview.model,
          runner_id: null,
          ...target,
          generation: 1,
          enabled: true,
          revoked: false,
          created_at: stamp(),
          limits: preview.limits,
        });
        await transaction(async (tx) => {
          this.guard(authority, epoch);
          await tx.put("connection/" + a.request_id, result);
        });
      } else if (a.action === "inspect-deployment") {
        if (!this.provisioner?.inspect)
          throw new AgentHubError("AGENT_UNCONFIGURED");
        const preview = await transaction((tx) =>
            read(tx, "deployment/" + a.preview_id, deploymentSchema),
          ),
          original = await transaction((tx) =>
            read(tx, receiptKey(a.source_request_id), receiptSchema),
          );
        if (
          preview.sha256 !== a.expected_sha256 ||
          original.input_sha256 !==
            digest({
              action: "deploy",
              request_id: a.source_request_id,
              preview_id: a.preview_id,
              expected_sha256: a.expected_sha256,
            })
        )
          throw new AgentHubError("AGENT_STALE");
        const observed = await this.provisioner.inspect(
          preview,
          operationAuthority,
        );
        result = observed;
        if (observed.initialized) {
          const connection = connectionSchema.parse({
            id: a.source_request_id,
            provider: "cloudflare",
            label: preview.label,
            model: preview.model,
            runner_id: null,
            ...observed.target,
            generation: 1,
            enabled: true,
            revoked: false,
            created_at: stamp(),
            limits: preview.limits,
          });
          await transaction(async (tx) => {
            this.guard(authority, epoch);
            const raw = await tx.get("connection/" + connection.id),
              existing = raw ? connectionSchema.parse(raw) : null;
            if (
              existing &&
              (existing.provider !== connection.provider ||
                existing.model !== connection.model ||
                existing.service_url !== connection.service_url ||
                existing.service_public_key !== connection.service_public_key ||
                existing.credential_id !== connection.credential_id)
            )
              throw new AgentHubError("AGENT_STALE");
            if (!existing)
              await tx.put("connection/" + connection.id, connection);
            result = existing ?? connection;
            await tx.put(receiptKey(a.source_request_id), {
              ...original,
              state: "completed",
              result,
            });
          });
        }
      } else if (a.action === "consent") {
        const connection = await this.connection(a.connection_id),
          context = await this.source(project, a.baseline);
        if (connection.generation !== a.generation || connection.revoked)
          throw new AgentHubError("AGENT_STALE");
        if (
          a.limits.turns_per_day > connection.limits.turns_per_day ||
          a.limits.output_bytes > connection.limits.output_bytes ||
          a.limits.runtime_ms > connection.limits.runtime_ms ||
          a.limits.max_output_tokens > connection.limits.max_output_tokens
        )
          throw new AgentHubError("AGENT_LIMIT");
        result = await transaction(async (tx) => {
          const id = "consent/" + connection.id + "/" + digest(context.binding),
            old = await tx.get(id);
          const consent = consentSchema.parse({
            connection_id: connection.id,
            binding: context.binding,
            generation: old ? consentSchema.parse(old).generation + 1 : 1,
            approved_at: stamp(),
            revoked_at: null,
            context: a.context,
            retention: a.retention,
            limits: a.limits,
          });
          this.guard(authority, epoch);
          tx.beforeCommit?.(() => this.invalidateConnection(connection.id));
          await tx.put(id, consent);
          return consent;
        });
      } else if (
        ["disconnect", "reconnect", "revoke"].includes(a.action) &&
        "connection_id" in a &&
        "generation" in a
      ) {
        result = await transaction(async (tx) => {
          const c = await read(
            tx,
            "connection/" + a.connection_id,
            connectionSchema,
          );
          if (c.generation !== a.generation || c.revoked)
            throw new AgentHubError("AGENT_STALE");
          const next = {
            ...c,
            enabled: a.action === "reconnect",
            revoked: a.action === "revoke",
            generation: c.generation + 1,
          };
          this.guard(authority, epoch);
          tx.beforeCommit?.(() => this.invalidateConnection(c.id));
          await tx.put("connection/" + c.id, next);
          return next;
        });
      } else if (a.action === "conversation") {
        const context = await this.source(project, a.baseline);
        result = await transaction(async (tx) => {
          const connection = await read(tx, "connection/" + a.connection_id, connectionSchema);
          if (!connection.enabled || connection.revoked)
            throw new AgentHubError("AGENT_AUTH", 403);
          const local = connection.provider === "codex" || connection.provider === "claude";
          if (local) {
            if (!connection.runner_id) throw new AgentHubError("AGENT_AUTH", 403);
            const runner = await read(tx, "runner/" + connection.runner_id, runnerSchema);
            if (runner.revoked || runner.runtime !== connection.provider)
              throw new AgentHubError("AGENT_AUTH", 403);
          }
          const key = "consent/" + connection.id + "/" + digest(context.binding),
            retained = await tx.get(key);
          // Starting a conversation scopes the durable local pairing to this
          // selected project. Retain existing limits and generation fences.
          if (!retained && !local) throw new AgentHubError("AGENT_AUTH", 403);
          const consent = retained ? consentSchema.parse(retained) : consentSchema.parse({
            connection_id: connection.id,
            binding: context.binding,
            generation: 1,
            approved_at: stamp(),
            revoked_at: null,
            context: "selected-intent",
            retention: "until-removed",
            limits: connection.limits,
          });
          if (consent.revoked_at || consent.connection_id !== connection.id ||
              digest(consent.binding) !== digest(context.binding))
            throw new AgentHubError("AGENT_AUTH", 403);
          if (
            (await list(tx, "conversation/", conversationSchema, 64)).length >=
            64
          )
            throw new AgentHubError("AGENT_LIMIT");
          const conversation = conversationSchema.parse({
            id: a.request_id,
            connection_id: connection.id,
            connection_generation: connection.generation,
            consent_generation: consent.generation,
            context,
            context_sha256: contextDigest(context),
            title: a.title,
            created_at: stamp(),
            turn_ids: [],
          });
          this.guard(authority, epoch);
          if (!retained) await tx.put(key, consent);
          await tx.put("conversation/" + a.request_id, conversation);
          return conversation;
        });
      } else if (a.action === "turn") {
        const conversation = await transaction((tx) =>
            read(tx, "conversation/" + a.conversation_id, conversationSchema),
          ),
          context = await this.source(project, conversation.context.baseline),
          connection = await this.connection(conversation.connection_id),
          consent = await this.authorized(connection, context);
        if (
          contextDigest(context) !== conversation.context_sha256 ||
          connection.generation !== conversation.connection_generation ||
          consent.generation !== conversation.consent_generation
        )
          throw new AgentHubError("AGENT_STALE");
        const history = await transaction(async (tx) => {
          const turns = [];
          for (const id of conversation.turn_ids)
            turns.push(await read(tx, "turn/" + id, turnSchema));
          return turns;
        });
        if (connection.runner_id) {
          const runner = await transaction((tx) =>
            read(tx, "runner/" + connection.runner_id, runnerSchema),
          );
          if (
            !runner.ready ||
            runner.revoked ||
            this.now() - Date.parse(runner.last_seen) >= 45000
          )
            throw new AgentHubError("AGENT_RUNTIME_OFFLINE", 503);
          if (runner.runtime === "codex" && !runner.models?.includes(connection.model))
            throw new AgentHubError("AGENT_MODEL_UNSUPPORTED");
        }
        if (
          history.some((t) =>
            ["queued", "running", "cancel_requested", "interrupted"].includes(
              t.state,
            ),
          )
        )
          throw new AgentHubError("AGENT_RECOVERY_REQUIRED");
        const messages = history.flatMap((t) => [
          { role: "user" as const, text: t.request.messages.at(-1)!.text },
          ...(t.output?.state === "succeeded"
            ? [{ role: "assistant" as const, text: t.output.text }]
            : []),
        ]);
        messages.push({ role: "user", text: a.text });
        const request = bounded(
          turnRequestSchema,
          {
            format: "strata-agent-chat/1",
            task_id: a.request_id,
            conversation_id: conversation.id,
            connection_id: connection.id,
            connection_generation: connection.generation,
            kind: a.kind,
            context,
            context_sha256: contextDigest(context),
            model: connection.model,
            limits: consent.limits,
            messages,
          },
          65536,
        );
        const turn = turnSchema.parse({
          id: a.request_id,
          conversation_id: conversation.id,
          request_sha256: digest(request),
          request,
          owner_generation: authority.authentication_generation,
          authority_epoch: this.authorityEpoch(),
          state: "queued",
          events: [{ sequence: 1, kind: "queued" }],
          output: null,
          claimed_by: null,
          created_at: stamp(),
          deadline: new Date(
            this.now() + request.limits.runtime_ms,
          ).toISOString(),
        });
        await transaction(async (tx) => {
          const current = await read(
            tx,
            "conversation/" + conversation.id,
            conversationSchema,
          );
          if (digest(current) !== digest(conversation))
            throw new AgentHubError("AGENT_STALE");
          const all = await list(tx, "turn/", turnSchema, 256);
          if (
            all.filter(
              (t) =>
                t.request.connection_id === connection.id &&
                [
                  "queued",
                  "running",
                  "cancel_requested",
                  "interrupted",
                ].includes(t.state),
            ).length >= 4 ||
            all.length >= 256 ||
            all.filter(
              (t) =>
                t.request.connection_id === connection.id &&
                Date.parse(t.created_at) >= this.now() - 86400000,
            ).length >= request.limits.turns_per_day
          )
            throw new AgentHubError("AGENT_LIMIT");
          this.guard(authority, epoch);
          tx.beforeCommit?.(() => this.guard(authority, epoch));
          await tx.put("turn/" + turn.id, turn);
          await tx.put("conversation/" + current.id, {
            ...current,
            turn_ids: [...current.turn_ids, turn.id],
          });
        });
        if (connection.provider === "cloudflare") {
          await this.runtimeCall(
            authority,
            project,
            connection,
            context,
            epoch,
            conversation.consent_generation,
            (control) => this.runtime.start(connection, request, control),
          );
          await authority.refresh();
          this.guard(authority, epoch);
        }
        result = turn;
      } else if (a.action === "inspect") {
        result = await this.inspect(authority, project, a.conversation_id);
      } else if (a.action === "cancel") {
        const { connection, turn, consent } = await this.turnAccess(
          authority,
          project,
          a.turn_id,
        );
        let cancelState = turn.state;
        await transaction(async (tx) => {
          const current = await read(tx, "turn/" + turn.id, turnSchema);
          if (["succeeded", "failed", "cancelled"].includes(current.state))
            return;
          this.guard(authority, epoch);
          if (connection.provider !== "cloudflare" && !current.claimed_by) {
            cancelState = "cancelled";
            await tx.put("turn/" + turn.id, {
              ...current,
              state: "cancelled",
              output: turnOutputSchema.parse({
                format: "strata-agent-chat-output/1",
                task_id: turn.id,
                request_sha256: turn.request_sha256,
                state: "cancelled",
                text: "",
                proposal: null,
                code: null,
              }),
              events: [
                ...current.events,
                { sequence: current.events.length + 1, kind: "cancelled" },
              ],
            });
            return;
          }
          cancelState = "cancel_requested";
          await tx.put("turn/" + turn.id, {
            ...current,
            state: "cancel_requested",
            events: [
              ...current.events,
              { sequence: current.events.length + 1, kind: "cancel_requested" },
            ],
          });
        });
        if (
          connection.provider === "cloudflare" &&
          cancelState === "cancel_requested"
        )
          await this.runtimeCall(
            authority,
            project,
            connection,
            turn.request.context,
            epoch,
            consent!.generation,
            (control) => this.runtime.cancel(connection, turn, control),
          );
        result = { turn_id: turn.id, state: cancelState };
      } else if (a.action === "inspect-save") {
        if (!project.inspectSave) throw new AgentHubError("AGENT_UNCONFIGURED");
        const original = await transaction((tx) =>
            read(tx, receiptKey(a.source_request_id), receiptSchema),
          ),
          meta = original.request_metadata;
        if (meta?.action !== "save" || typeof meta.turn_id !== "string")
          throw new AgentHubError("AGENT_STALE");
        const { turn, context, connection } = await this.turnAccess(
            authority,
            project,
            meta.turn_id,
            true,
          ),
          proposal = bounded(proposalSchema, turn.output?.proposal);
        const reservation = await transaction(async (tx) =>
          z
            .object({
              request_id: uuid,
              proposal_sha256: hash,
              layer_id: z.string(),
            })
            .strict()
            .parse(await tx.get("save-reservation/" + turn.id)),
        );
        if (
          reservation.request_id !== a.source_request_id ||
          original.input_sha256 !==
            digest({
              action: "save",
              request_id: a.source_request_id,
              turn_id: turn.id,
              proposal_sha256: reservation.proposal_sha256,
              layer_id: reservation.layer_id,
            }) ||
          reservation.proposal_sha256 !== digest(proposal)
        )
          throw new AgentHubError("AGENT_STALE");
        const draft = await this.draft(proposal, context, reservation.layer_id),
          observed = await project.inspectSave(a.source_request_id);
        this.guard(authority, epoch);
        result = { committed: observed.committed };
        if (observed.committed) {
          if (observed.draft_sha256 !== digest(draft))
            throw new AgentHubError("AGENT_STALE");
          const provenance = provenanceSchema.parse({
            turn_id: turn.id,
            proposal_sha256: digest(proposal),
            context_sha256: contextDigest(context),
            provider: connection.provider,
            model: connection.model,
            draft_result: observed.result,
          });
          await transaction(async (tx) => {
            const old = await tx.get("saved/" + turn.id);
            if (old) {
              const retained = provenanceSchema.parse(old);
              if (
                (
                  [
                    "turn_id",
                    "proposal_sha256",
                    "context_sha256",
                    "provider",
                    "model",
                  ] as const
                ).some((key) => retained[key] !== provenance[key])
              )
                throw new AgentHubError("AGENT_STALE");
              result = retained;
            }
            if (!old) await tx.put("saved/" + turn.id, provenance);
            await tx.put(receiptKey(a.source_request_id), {
              ...original,
              state: "completed",
              result: old ?? provenance,
            });
          });
          if (!provenanceSchema.safeParse(result).success) result = provenance;
        }
      } else if (a.action === "save") {
        const { turn, connection, context, consent } = await this.turnAccess(
            authority,
            project,
            a.turn_id,
          ),
          proposal = bounded(proposalSchema, turn.output?.proposal);
        if (
          turn.state !== "succeeded" ||
          proposal.questions.length ||
          digest(proposal) !== a.proposal_sha256 ||
          proposal.context_sha256 !== contextDigest(context) ||
          proposal.baseline !== context.baseline
        )
          throw new AgentHubError("AGENT_STALE");
        const draft = await this.draft(proposal, context, a.layer_id);
        await transaction(async (tx) => {
          if (
            (await tx.get("saved/" + turn.id)) ||
            (await tx.get("save-reservation/" + turn.id))
          )
            throw new AgentHubError("AGENT_STALE");
          await tx.put("save-reservation/" + turn.id, {
            request_id: a.request_id,
            proposal_sha256: a.proposal_sha256,
            layer_id: a.layer_id,
          });
        });
        result = await this.runtimeCall(
          authority, project, connection, context, epoch, consent!.generation,
          async (control) => {
            control.assertLive();
            hasEffect = true;
            const saved = await project.save(draft, a.request_id, context);
            await control.refresh();
            const provenance = provenanceSchema.parse({
              turn_id: turn.id,
              proposal_sha256: digest(proposal),
              context_sha256: contextDigest(context),
              provider: connection.provider,
              model: connection.model,
              draft_result: saved,
            });
            await transaction(async (tx) => {
              control.assertLive();
              tx.beforeCommit?.(control.assertLive);
              await tx.put("saved/" + turn.id, provenance);
            });
            return provenance;
          },
        );
      } else throw new AgentHubError("AGENT_INVALID", 400);
      await authority.refresh();
      this.guard(authority, epoch);
      await this.complete(a.request_id, result, authority, epoch);
      return { replayed: false, result };
    } catch (e) {
      await transaction(async (tx) => {
        const r = await read(tx, receiptKey(a.request_id), receiptSchema);
        await tx.put(receiptKey(a.request_id), {
          ...r,
          state: hasEffect ? "uncertain" : "failed",
          result:
            e instanceof AgentHubError
              ? { state: "failed", code: e.code }
              : null,
        });
      }).catch(() => {});
      if (e instanceof AgentHubError) throw e;
      throw new AgentHubError("AGENT_RECOVERY_REQUIRED", 503);
    }
  }
  private async complete(
    id: string,
    result: unknown,
    authority: AgentAuthority,
    epoch: number,
  ) {
    await this.state.transaction(async (tx) => {
      const r = await read(tx, receiptKey(id), receiptSchema);
      this.guard(authority, epoch);
      tx.beforeCommit?.(() => this.guard(authority, epoch));
      await tx.put(receiptKey(id), { ...r, state: "completed", result });
    });
  }
  private async turnAccess(
    authority: AgentAuthority,
    project: AgentProjectPort,
    id: string,
    history = false,
  ) {
    this.guard(authority, this.epoch);
    const turn = await this.state.transaction((tx) =>
        read(tx, "turn/" + id, turnSchema),
      ),
      context = await this.source(project, turn.request.context.baseline),
      connection = await this.connection(turn.request.connection_id);
    const consent = history ? null : await this.authorized(connection, context),
      conversation = await this.state.transaction((tx) =>
        read(tx, "conversation/" + turn.conversation_id, conversationSchema),
      );
    if (
      contextDigest(context) !== turn.request.context_sha256 ||
      (!history &&
        (connection.generation !== turn.request.connection_generation ||
          consent!.generation !== conversation.consent_generation))
    )
      throw new AgentHubError("AGENT_STALE");
    return { turn, context, connection, consent };
  }
  async conversations(
    authority: AgentAuthority,
    project: AgentProjectPort,
    baseline: string,
  ) {
    this.guard(authority, this.epoch);
    const epoch = this.epoch,
      context = await this.source(project, baseline);
    this.guard(authority, epoch);
    return this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guard(authority, epoch));
      return (await list(tx, "conversation/", conversationSchema, 64))
        .filter((c) => digest(c.context.binding) === digest(context.binding))
        .map(({ context, ...c }) => c);
    });
  }
  async inspect(
    authority: AgentAuthority,
    project: AgentProjectPort,
    id: string,
    recover = true,
  ) {
    const epoch = this.epoch;
    this.guard(authority, epoch);
    const conv = await this.state.transaction((tx) =>
      read(tx, "conversation/" + id, conversationSchema),
    );
    const context = await this.source(project, conv.context.baseline);
    if (contextDigest(context) !== conv.context_sha256)
      throw new AgentHubError("AGENT_STALE");
    const connection = await this.connection(conv.connection_id);
    let archived = false;
    try {
      const consent = await this.authorized(connection, context);
      archived =
        connection.generation !== conv.connection_generation ||
        consent.generation !== conv.consent_generation;
    } catch (e) {
      if (
        e instanceof AgentHubError &&
        ["AGENT_AUTH", "AGENT_NOT_FOUND"].includes(e.code)
      )
        archived = true;
      else throw e;
    }
    for (const turnId of archived ? [] : conv.turn_ids) {
      const { turn } = await this.turnAccess(authority, project, turnId, true);
      if (
        !recover &&
        (connection.provider !== "cloudflare" ||
          turn.authority_epoch !== this.authorityEpoch() ||
          Date.parse(turn.deadline) <= this.now())
      )
        continue;
      if (
        !turn.output &&
        (turn.authority_epoch !== this.authorityEpoch() ||
          (connection.provider !== "cloudflare" &&
            !turn.claimed_by &&
            Date.parse(turn.deadline) <= this.now()))
      ) {
        await this.state.transaction(async (tx) => {
          const current = await read(tx, "turn/" + turn.id, turnSchema);
          tx.beforeCommit?.(() => this.guard(authority, epoch));
          if (connection.provider !== "cloudflare" && !current.claimed_by) {
            const output = turnOutputSchema.parse({
              format: "strata-agent-chat-output/1",
              task_id: turn.id,
              request_sha256: turn.request_sha256,
              state: "failed",
              text: "",
              proposal: null,
              code: "AGENT_NOT_STARTED",
            });
            await tx.put("turn/" + turn.id, {
              ...current,
              state: "failed",
              output,
              events: [
                ...current.events,
                { sequence: current.events.length + 1, kind: "failed" },
              ],
            });
          } else
            await tx.put("turn/" + turn.id, {
              ...current,
              authority_epoch: this.authorityEpoch(),
            });
        });
        turn.authority_epoch = this.authorityEpoch();
      }
      if (
        connection.provider !== "cloudflare" &&
        turn.claimed_by &&
        !turn.output
      ) {
        await this.state.transaction(async (tx) => {
          tx.beforeCommit?.(() => this.guard(authority, epoch));
          await tx.put("runner-inspect/" + turn.id, {
            task: turn.request,
            claimed: false,
          });
        });
      }
      if (
        connection.provider === "cloudflare" &&
        ["queued", "running", "cancel_requested", "interrupted"].includes(
          turn.state,
        )
      ) {
        const result = await this.runtimeCall(
          authority,
          project,
          connection,
          context,
          epoch,
          conv.consent_generation,
          (control) => this.runtime.inspect(connection, turn, control),
        );
        if (result.events?.length)
          await this.observedText(turn, result.events.at(-1)!);
        if (result.output) await this.acceptOutput(turn, result.output);
        else if (result.state === "interrupted")
          await this.state.transaction(async (tx) => {
            const row = await read(tx, "turn/" + turn.id, turnSchema);
            tx.beforeCommit?.(() => this.guard(authority, epoch));
            if (!row.output && row.state !== "interrupted")
              await tx.put("turn/" + turn.id, {
                ...row,
                state: "interrupted",
                events: [
                  ...row.events,
                  { sequence: row.events.length + 1, kind: "interrupted" },
                ],
              });
          });
      }
    }
    return this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guard(authority, epoch));
      return {
        format: "strata-studio-agent-conversation-view/1",
        conversation: conv,
        archived,
        turns: await Promise.all(
          conv.turn_ids.map(async (id) => {
            const turn = await read(tx, "turn/" + id, turnSchema),
              raw = await tx.get("saved/" + id),
              saved = raw ? provenanceSchema.parse(raw) : null;
            const result = saved?.draft_result as
              | { ref?: string; data?: { ref?: string } }
              | undefined;
            return {
              id: turn.id,
              conversation_id: turn.conversation_id,
              request_sha256: turn.request_sha256,
              request: {
                kind: turn.request.kind,
                context_sha256: turn.request.context_sha256,
                messages: turn.request.messages.slice(-1),
              },
              state: turn.state,
              events: turn.output
                ? turn.events.map(({ text, ...event }) => event)
                : turn.events,
              output: turn.output,
              deadline: turn.deadline,
              claimed_by: turn.claimed_by,
              saved: !!saved,
              draft_ref: result?.data?.ref ?? result?.ref ?? null,
            };
          }),
        ),
      };
    });
  }
  private async draft(proposal: unknown, context: AgentContext, id: string) {
    const p = proposalSchema.parse(proposal);
    try {
      const snapshot = normalizeSnapshot({
        ...context.snapshot_metadata,
        model_version: context.binding.model_version,
        blocks: context.blocks,
      });
      return normalizeLayer(
        {
          id,
          revision: 1,
          owner: context.principal_id,
          model_version: context.binding.model_version,
          baseline: context.baseline,
          intent: p.intent,
          changes: p.changes,
          acceptance: [],
          requires_layers: [],
          read_set: [],
          assumptions: [],
          resolution_proposals: [],
          derived_from: null,
          ...(context.binding.model_version === BLOCK_MODEL
            ? { created_blocks: [] }
            : {}),
        },
        snapshot,
      );
    } catch {
      throw new AgentHubError("AGENT_INVALID", 422);
    }
  }
  async pair(input: unknown) {
    const epoch = this.epoch;
    const a = bounded(
        z
          .object({
            pairing_id: uuid,
            code: z.string().min(16).max(128),
            label: z.string().min(1).max(128),
            runtime: runnerSchema.shape.runtime,
            version: z.string().min(1).max(128),
          })
          .strict(),
        input,
        2048,
      ),
      token = Buffer.from(randomBytes(32)).toString("base64url"),
      id = randomUUID();
    await this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guardEpoch(epoch));
      const pair = await read(tx, "pair/" + a.pairing_id, pairingSchema);
      if (
        pair.used ||
        pair.authority_epoch !== this.authorityEpoch() ||
        pair.runtime !== a.runtime ||
        Date.parse(pair.expires_at) <= this.now() ||
        !compare(pair.code_sha256, digest(a.code))
      )
        throw new AgentHubError("AGENT_PAIR_EXPIRED", 403);
      if ((await list(tx, "runner/", runnerSchema, 32)).length >= 32)
        throw new AgentHubError("AGENT_LIMIT");
      await tx.put("pair/" + pair.id, { ...pair, used: true });
      await tx.put("runner/" + id, {
        id,
        label: a.label,
        token_sha256: digest(token),
        generation: 1,
        runtime: a.runtime,
        version: a.version,
        ready: false,
        last_seen: stamp(),
        revoked: false,
      });
    });
    return { runner_id: id, token };
  }
  private async runner(id: string, token: string) {
    uuid.parse(id);
    const runner = await this.state.transaction((tx) =>
      read(tx, "runner/" + id, runnerSchema),
    );
    if (runner.revoked || !compare(runner.token_sha256, digest(token)))
      throw new AgentHubError("AGENT_AUTH", 403);
    return runner;
  }
  async poll(id: string, token: string, ready: boolean, busy = false, models?: string[]) {
    const epoch = this.epoch;
    const runner = await this.runner(id, token);
    const catalog = models === undefined ? runner.models : runnerSchema.shape.models.parse(models);
    ready = ready && (runner.runtime !== "codex" || !!catalog?.length);
    return this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guardEpoch(epoch));
      await tx.put("runner/" + id, {
        ...runner,
        ready,
        models: ready ? catalog : [],
        login: ready ? null : (runner.login ?? null),
        last_seen: stamp(),
      });
      const rawLogin = await tx.get("runner-login/" + id);
      let login_id: string | null = null;
      if (rawLogin) {
        const job = z
          .object({
            id: uuid,
            claimed: z.boolean(),
            authority_epoch: z.string().max(128),
          })
          .strict()
          .parse(rawLogin);
        if (!job.claimed && job.authority_epoch === this.authorityEpoch()) {
          login_id = job.id;
          await tx.put("runner-login/" + id, { ...job, claimed: true });
        }
      }
      const validConnections = (
        await list(tx, "connection/", connectionSchema, 32)
      ).filter((c) => c.runner_id === id && c.enabled && !c.revoked);
      const rawTurns = await list(tx, "turn/", turnSchema, 256),
        retainedTurns = [];
      for (const turn of rawTurns) {
        const conv = await read(
            tx,
            "conversation/" + turn.conversation_id,
            conversationSchema,
          ),
          consent = await read(
            tx,
            "consent/" +
              turn.request.connection_id +
              "/" +
              digest(turn.request.context.binding),
            consentSchema,
          );
        if (
          !consent.revoked_at &&
          consent.generation === conv.consent_generation
        )
          retainedTurns.push(turn);
      }
      const requestedCancel = retainedTurns
        .filter(
          (t) =>
            t.claimed_by === id &&
            t.state === "cancel_requested" &&
            t.authority_epoch === this.authorityEpoch() &&
            validConnections.some(
              (c) =>
                c.id === t.request.connection_id &&
                c.generation === t.request.connection_generation,
            ),
        )
        .map((t) => t.id);
      let inspect: TurnRequest | null = null;
      if (!busy)
        for (const t of retainedTurns.filter(
          (t) =>
            t.claimed_by === id &&
            !t.output &&
            t.authority_epoch === this.authorityEpoch() &&
            validConnections.some(
              (c) =>
                c.id === t.request.connection_id &&
                c.generation === t.request.connection_generation,
            ),
        )) {
          const raw = await tx.get("runner-inspect/" + t.id);
          if (raw) {
            const job = z
              .object({ task: turnRequestSchema, claimed: z.boolean() })
              .strict()
              .parse(raw);
            if (!job.claimed) {
              inspect = job.task;
              await tx.put("runner-inspect/" + t.id, { ...job, claimed: true });
              break;
            }
          }
        }
      if (!ready || busy || inspect)
        return { task: null, inspect, cancel: requestedCancel, login_id };
      const connections = (
        await list(tx, "connection/", connectionSchema, 32)
      ).filter((c) => c.runner_id === id && c.enabled && !c.revoked);
      const turns = retainedTurns,
        cancel = turns
          .filter(
            (t) =>
              t.claimed_by === id &&
              t.state === "cancel_requested" &&
              t.authority_epoch === this.authorityEpoch() &&
              validConnections.some(
                (c) =>
                  c.id === t.request.connection_id &&
                  c.generation === t.request.connection_generation,
              ),
          )
          .map((t) => t.id);
      const turn = turns.find(
        (t) =>
          t.state === "queued" &&
          t.authority_epoch === this.authorityEpoch() &&
          !t.claimed_by &&
          Date.parse(t.deadline) > this.now() &&
          connections.some(
            (c) =>
              c.id === t.request.connection_id &&
              c.generation === t.request.connection_generation,
          ),
      );
      if (!turn) return { task: null, cancel, login_id };
      await this.dispatchFence?.(turn.request.context, turn.owner_generation);
      await tx.put("turn/" + turn.id, {
        ...turn,
        state: "running",
        claimed_by: id,
        events: [
          ...turn.events,
          { sequence: turn.events.length + 1, kind: "started" },
        ],
      });
      return {
        task: turn.request,
        request_sha256: turn.request_sha256,
        cancel,
        login_id,
      };
    });
  }
  async output(id: string, token: string, input: unknown) {
    await this.runner(id, token);
    const output = bounded(turnOutputSchema, input);
    const turn = await this.state.transaction((tx) =>
      read(tx, "turn/" + output.task_id, turnSchema),
    );
    if (turn.claimed_by !== id) throw new AgentHubError("AGENT_AUTH", 403);
    await this.dispatchFence?.(turn.request.context, turn.owner_generation);
    return this.acceptOutput(turn, output);
  }
  private async observedText(turn: AgentTurn, text: string) {
    const epoch = this.epoch;
    await this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guardEpoch(epoch));
      const current = await read(tx, "turn/" + turn.id, turnSchema);
      if (current.authority_epoch !== this.authorityEpoch() || current.output)
        return;
      const before = current.events
        .filter((e) => e.kind === "text")
        .map((e) => e.text ?? "")
        .join("");
      if (!text.startsWith(before)) throw new AgentHubError("AGENT_STALE");
      const delta = text.slice(before.length),
        parts = [];
      for (let i = 0; i < delta.length; i += 4096)
        parts.push(delta.slice(i, i + 4096));
      if (
        current.events.length + parts.length > 255 ||
        Buffer.byteLength(text) > turn.request.limits.output_bytes
      )
        throw new AgentHubError("AGENT_LIMIT");
      if (parts.length)
        await tx.put("turn/" + turn.id, {
          ...current,
          state: "running",
          events: [
            ...current.events,
            ...parts.map((text, i) => ({
              sequence: current.events.length + i + 1,
              kind: "text",
              text,
            })),
          ],
        });
    });
  }
  async progress(id: string, token: string, input: unknown) {
    const epoch = this.epoch;
    await this.runner(id, token);
    const p = bounded(
      z
        .object({
          task_id: uuid,
          request_sha256: hash,
          text: z.string().max(65536),
        })
        .strict(),
      input,
      65536,
    );
    await this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guardEpoch(epoch));
      const t = await read(tx, "turn/" + p.task_id, turnSchema),
        c = await read(
          tx,
          "connection/" + t.request.connection_id,
          connectionSchema,
        );
      if (
        t.claimed_by !== id ||
        t.request_sha256 !== p.request_sha256 ||
        t.authority_epoch !== this.authorityEpoch() ||
        !c.enabled ||
        c.revoked ||
        c.generation !== t.request.connection_generation ||
        t.output
      )
        throw new AgentHubError("AGENT_STALE");
      await this.dispatchFence?.(t.request.context, t.owner_generation);
      const previous = t.events
        .filter((e) => e.kind === "text")
        .map((e) => e.text ?? "")
        .join("");
      if (!p.text.startsWith(previous)) throw new AgentHubError("AGENT_STALE");
      if (p.text.length === previous.length) return;
      const delta = p.text.slice(previous.length),
        chunks = [];
      for (let i = 0; i < delta.length; i += 4096)
        chunks.push(delta.slice(i, i + 4096));
      if (
        t.events.length + chunks.length > 255 ||
        Buffer.byteLength(p.text) > t.request.limits.output_bytes
      )
        throw new AgentHubError("AGENT_LIMIT");
      await tx.put("turn/" + t.id, {
        ...t,
        events: [
          ...t.events,
          ...chunks.map((text, i) => ({
            sequence: t.events.length + i + 1,
            kind: "text",
            text,
          })),
        ],
      });
    });
    return { accepted: true };
  }
  async loginOutput(id: string, token: string, input: unknown) {
    const epoch = this.epoch;
    await this.runner(id, token);
    const login = bounded(
      z
        .object({
          login_id: uuid,
          verification_url: z.literal("https://auth.openai.com/codex/device"),
          user_code: z.string().min(1).max(64),
        })
        .strict(),
      input,
      1024,
    );
    await this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guardEpoch(epoch));
      const job = z
        .object({
          id: uuid,
          claimed: z.boolean(),
          authority_epoch: z.string().max(128),
        })
        .strict()
        .parse(await tx.get("runner-login/" + id));
      if (
        !job.claimed ||
        job.id !== login.login_id ||
        job.authority_epoch !== this.authorityEpoch()
      )
        throw new AgentHubError("AGENT_STALE");
      const runner = await read(tx, "runner/" + id, runnerSchema);
      await tx.put("runner/" + id, {
        ...runner,
        login: {
          verification_url: login.verification_url,
          user_code: login.user_code,
        },
      });
    });
    return { accepted: true };
  }
  private async acceptOutput(turn: AgentTurn, input: unknown) {
    const epoch = this.epoch;
    const output = bounded(
      turnOutputSchema,
      input,
      turn.request.limits.output_bytes,
    );
    if (
      output.task_id !== turn.id ||
      output.request_sha256 !== turn.request_sha256 ||
      (output.proposal &&
        (output.proposal.context_sha256 !== turn.request.context_sha256 ||
          output.proposal.baseline !== turn.request.context.baseline))
    )
      throw new AgentHubError("AGENT_STALE");
    return this.state.transaction(async (tx) => {
      tx.beforeCommit?.(() => this.guardEpoch(epoch));
      const current = await read(tx, "turn/" + turn.id, turnSchema),
        connection = await read(
          tx,
          "connection/" + turn.request.connection_id,
          connectionSchema,
        ),
        consent = await read(
          tx,
          "consent/" +
            connection.id +
            "/" +
            digest(turn.request.context.binding),
          consentSchema,
        ),
        conversation = await read(
          tx,
          "conversation/" + turn.conversation_id,
          conversationSchema,
        );
      if (
        turn.authority_epoch !== this.authorityEpoch() ||
        !connection.enabled ||
        connection.revoked ||
        connection.generation !== turn.request.connection_generation ||
        consent.revoked_at ||
        consent.generation !== conversation.consent_generation
      )
        throw new AgentHubError("AGENT_STALE");
      if (current.output) {
        if (digest(current.output) !== digest(output))
          throw new AgentHubError("AGENT_STALE");
        return { accepted: true, replayed: true };
      }

      await tx.put("turn/" + turn.id, {
        ...current,
        state: output.state,
        output,
        events: [
          ...current.events,
          {
            sequence: current.events.length + 1,
            kind: output.state === "succeeded" ? "completed" : output.state,
          },
        ],
      });
      const receipt = await tx.get(receiptKey(turn.id));
      if (receipt) {
        const r = receiptSchema.parse(receipt);
        if (r.state !== "completed")
          await tx.put(receiptKey(turn.id), {
            ...r,
            state: "completed",
            result: { turn_id: turn.id, state: output.state },
          });
      }
      return { accepted: true, replayed: false };
    });
  }
}
