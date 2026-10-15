import { z } from "zod";
import { digest, expectedSchema } from "../model.js";

export const AGENT_CHAT = "strata-agent-chat/1" as const;
export const uuid = z
  .string()
  .uuid()
  .regex(/^[a-f0-9-]{36}$/);
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const key = z.string().regex(/^[@A-Za-z0-9_.:/-]{1,256}$/);
export const provider = z.enum(["cloudflare", "codex", "claude"]);
export const limits = z
  .object({
    turns_per_day: z.number().int().min(1).max(1000),
    runtime_ms: z.number().int().min(1000).max(300000),
    output_bytes: z.number().int().min(1024).max(65536),
    max_output_tokens: z.number().int().min(64).max(4096),
  })
  .strict();
export const binding = z
  .object({ project_id: key, model_version: key, repository_id: key })
  .strict();
export const contextSchema = z
  .object({
    binding,
    baseline: key,
    baseline_sha256: hash,
    generation: hash,
    policy: key,
    principal_id: key,
    selection_epoch: z.number().int().nonnegative(),
    snapshot_metadata: z
      .object({
        id: key,
        revision: z.number().int().positive(),
        root: key,
        authorities: z.unknown(),
        deleted_ids: z.array(key),
      })
      .strict(),
    blocks: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AgentContext = z.infer<typeof contextSchema>;
export const contextDigest = (context: AgentContext) =>
  digest({
    binding: context.binding,
    baseline: context.baseline,
    baseline_sha256: context.baseline_sha256,
    principal_id: context.principal_id,
    snapshot_metadata: context.snapshot_metadata,
    blocks: context.blocks,
  });
const proposalEnvelopeSchema = z
  .object({
    format: z.literal("strata-agent-draft-proposal/1"),
    baseline: key,
    context_sha256: hash,
    intent: z.string().min(1).max(4096),
    changes: z
      .array(
        z
          .object({
            op: z.literal("set_item"),
            block: key,
            path: z.string().regex(/^(purpose|requirements\.[A-Za-z0-9_-]+)$/),
            expected: expectedSchema,
            value: z.unknown(),
          })
          .strict(),
      )
      .min(0)
      .max(25),
    questions: z.array(z.string().max(1000)).max(16),
  })
  .strict();
const hasProposalContent = (p: { changes: unknown[]; questions: string[] }) =>
  p.changes.length > 0 || p.questions.length > 0;
export const proposalSchema = proposalEnvelopeSchema.refine(
    hasProposalContent,
    "A proposal needs changes or unresolved questions.",
  );
// Preserve inspection of previously retained untrusted envelopes. New output
// admission and every draft Save continue to use the canonical proposalSchema.
const retainedProposalSchema = proposalEnvelopeSchema.extend({
  changes: z.array(proposalEnvelopeSchema.shape.changes.element.extend({
    expected: z.unknown(),
  })).min(0).max(25),
}).refine(hasProposalContent, "A proposal needs changes or unresolved questions.");
export type DraftProposal = z.infer<typeof proposalSchema>;
export const connectionSchema = z
  .object({
    id: uuid,
    provider,
    label: z.string().min(1).max(128),
    model: key,
    runner_id: uuid.nullable(),
    service_url: z.string().url().nullable(),
    service_public_key: z.string().max(256).nullable(),
    credential_id: uuid.nullable(),
    generation: z.number().int().positive(),
    enabled: z.boolean(),
    revoked: z.boolean(),
    created_at: z.string().datetime(),
    limits,
  })
  .strict();
export type AgentConnection = z.infer<typeof connectionSchema>;
export const consentSchema = z
  .object({
    connection_id: uuid,
    binding,
    generation: z.number().int().positive(),
    approved_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable(),
    context: z.literal("selected-intent"),
    retention: z.literal("until-removed"),
    limits,
  })
  .strict();
export type AgentConsent = z.infer<typeof consentSchema>;
export const turnRequestSchema = z
  .object({
    format: z.literal(AGENT_CHAT),
    task_id: uuid,
    conversation_id: uuid,
    connection_id: uuid,
    connection_generation: z.number().int().positive(),
    kind: z.enum(["chat", "proposal"]),
    context: contextSchema,
    context_sha256: hash,
    model: key,
    limits,
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: z.string().max(65536),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();
export type TurnRequest = z.infer<typeof turnRequestSchema>;
export const turnOutputSchema = z
  .object({
    format: z.literal("strata-agent-chat-output/1"),
    trust: z.literal("agent-output").default("agent-output"),
    task_id: uuid,
    request_sha256: hash,
    state: z.enum(["succeeded", "failed", "cancelled"]),
    text: z.string().max(65536),
    proposal: proposalSchema.nullable(),
    code: z
      .string()
      .regex(/^[A-Z_]{1,64}$/)
      .nullable(),
  })
  .strict();
export type TurnOutput = z.infer<typeof turnOutputSchema>;
const retainedTurnOutputSchema = turnOutputSchema.extend({
  proposal: retainedProposalSchema.nullable(),
});
export const eventSchema = z
  .object({
    sequence: z.number().int().positive(),
    kind: z.enum([
      "queued",
      "started",
      "text",
      "completed",
      "failed",
      "cancel_requested",
      "cancelled",
      "interrupted",
    ]),
    text: z.string().max(4096).optional(),
  })
  .strict();
export const turnSchema = z
  .object({
    id: uuid,
    conversation_id: uuid,
    request_sha256: hash,
    request: turnRequestSchema,
    owner_generation: z.number().int().positive(),
    authority_epoch: z.string().max(128),
    state: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancel_requested",
      "cancelled",
      "interrupted",
    ]),
    events: z.array(eventSchema).max(256),
    output: retainedTurnOutputSchema.nullable(),
    claimed_by: uuid.nullable(),
    created_at: z.string().datetime(),
    deadline: z.string().datetime(),
  })
  .strict();
export type AgentTurn = z.infer<typeof turnSchema>;
export const conversationSchema = z
  .object({
    id: uuid,
    connection_id: uuid,
    connection_generation: z.number().int().positive(),
    consent_generation: z.number().int().positive(),
    context: contextSchema,
    context_sha256: hash,
    title: z.string().min(1).max(128),
    created_at: z.string().datetime(),
    turn_ids: z.array(uuid).max(128),
  })
  .strict();
export type AgentConversation = z.infer<typeof conversationSchema>;
export const runnerSchema = z
  .object({
    id: uuid,
    label: z.string().min(1).max(128),
    token_sha256: hash,
    generation: z.number().int().positive(),
    runtime: provider.exclude(["cloudflare"]),
    version: z.string().min(1).max(128),
    ready: z.boolean(),
    models: z.array(key).max(256).optional(),
    login: z
      .object({
        verification_url: z.literal("https://auth.openai.com/codex/device"),
        user_code: z.string().max(64),
      })
      .strict()
      .nullable()
      .optional(),
    last_seen: z.string().datetime(),
    revoked: z.boolean(),
  })
  .strict();
export const runnerPacketSchema = z.object({
  task: turnRequestSchema.nullable().optional(),
  inspect: turnRequestSchema.nullable().optional(),
  request_sha256: hash.optional(),
  cancel: z.array(uuid).max(256),
  login_id: uuid.nullable(),
}).strict().refine(p => !p.task || p.request_sha256 === digest(p.task),
  "Runner task must retain its original request digest.");
export const ownerActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("inspect-save"),
      request_id: uuid,
      source_request_id: uuid,
    })
    .strict(),
  z.object({ action: z.literal("initialize"), request_id: uuid }).strict(),
  z
    .object({
      action: z.literal("pair"),
      request_id: uuid,
      runtime: provider.exclude(["cloudflare"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("runner-login"),
      request_id: uuid,
      runner_id: uuid,
    })
    .strict(),
  z
    .object({
      action: z.literal("add-runner"),
      request_id: uuid,
      runner_id: uuid,
      label: z.string().min(1).max(128),
      model: key,
      limits,
    })
    .strict(),
  z
    .object({
      action: z.literal("credential"),
      request_id: uuid,
      value: z.string().min(1).max(2048),
    })
    .strict(),
  z
    .object({
      action: z.literal("deployment-preview"),
      request_id: uuid,
      account_id: z.string().regex(/^[a-f0-9]{32}$/),
      credential_id: uuid,
      label: z.string().min(1).max(128),
      model: key,
      limits,
    })
    .strict(),
  z
    .object({
      action: z.literal("inspect-deployment"),
      request_id: uuid,
      source_request_id: uuid,
      preview_id: uuid,
      expected_sha256: hash,
    })
    .strict(),
  z
    .object({
      action: z.literal("deploy"),
      request_id: uuid,
      preview_id: uuid,
      expected_sha256: hash,
    })
    .strict(),
  z
    .object({
      action: z.literal("consent"),
      request_id: uuid,
      connection_id: uuid,
      generation: z.number().int().positive(),
      baseline: key,
      context: z.literal("selected-intent"),
      retention: z.literal("until-removed"),
      limits,
    })
    .strict(),
  z
    .object({
      action: z.enum(["disconnect", "reconnect", "revoke"]),
      request_id: uuid,
      connection_id: uuid,
      generation: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("conversation"),
      request_id: uuid,
      connection_id: uuid,
      baseline: key,
      title: z.string().min(1).max(128),
    })
    .strict(),
  z
    .object({
      action: z.literal("turn"),
      request_id: uuid,
      conversation_id: uuid,
      kind: z.enum(["chat", "proposal"]),
      text: z.string().min(1).max(8192),
    })
    .strict(),
  z
    .object({ action: z.literal("cancel"), request_id: uuid, turn_id: uuid })
    .strict(),
  z
    .object({
      action: z.literal("inspect"),
      request_id: uuid,
      conversation_id: uuid,
    })
    .strict(),
  z
    .object({
      action: z.literal("save"),
      request_id: uuid,
      turn_id: uuid,
      proposal_sha256: hash,
      layer_id: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    })
    .strict(),
]);
export type OwnerAgentAction = z.infer<typeof ownerActionSchema>;
export function bounded<T>(
  schema: z.ZodType<T>,
  value: unknown,
  maximum = 65536,
): T {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > maximum)
    throw new AgentHubError("AGENT_LIMIT", 413);
  const result = schema.safeParse(value);
  if (!result.success) throw new AgentHubError("AGENT_INVALID", 400);
  return result.data;
}
export class AgentHubError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(
      {
        AGENT_UNCONFIGURED: "Agent hosting is not configured.",
        AGENT_SOURCE_UNAVAILABLE:
          "Select an authorized project and exact baseline.",
        AGENT_STALE:
          "Agent context or authority changed. Inspect the original operation.",
        AGENT_LIMIT: "The approved agent limit was reached.",
        AGENT_INVALID: "The agent request or output is invalid.",
        AGENT_PAIR_EXPIRED: "The pairing code expired or was consumed.",
        AGENT_RUNTIME_OFFLINE: "The paired agent runner is offline.",
        AGENT_RECOVERY_REQUIRED:
          "Inspect the original operation before trying again.",
        AGENT_STATE_UNAVAILABLE:
          "Protected agent state needs operator reconciliation.",
        AGENT_MODEL_UNSUPPORTED: "Choose a qualified model for this provider.",
        AGENT_AUTH: "Current agent authorization is required.",
        AGENT_NOT_FOUND: "The requested agent record was not found.",
      }[code] ?? "The requested agent operation could not complete.",
    );
  }
}
export const hashValue = digest;
