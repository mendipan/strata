import path from "node:path";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import {
  LocalExecutionStorage,
  type LocalExecutionStorageCustody,
} from "../agent-adapters/local-execution-storage.js";
import { privateDir } from "../explorer/owner-files.js";
import type { CloudflareExecutionTransaction } from "../agent-adapters/cloudflare-execution-journal.js";
import { AgentHubError } from "./protocol.js";

const genesis = z
  .object({
    format: z.literal("strata-studio-agent-hub/1"),
    installation_id: z.string().uuid(),
    owner_id: z.string().uuid(),
  })
  .strict();
export class AgentHubState {
  readonly storage: LocalExecutionStorage;
  constructor(
    readonly directory: string,
    readonly installationId: string,
    readonly ownerId: string,
    custody?: LocalExecutionStorageCustody,
  ) {
    this.storage = new LocalExecutionStorage(
      path.join(directory, "control"),
      { role: "host", owner_id: ownerId, connection_id: installationId },
      custody,
    );
  }
  async provision() {
    await privateDir(this.directory, true);
    await privateDir(path.join(this.directory, "control"), true);
    await this.storage.provisionEmpty();
    await this.storage.transaction(async (tx) => {
      await tx.put("hub/genesis", {
        format: "strata-studio-agent-hub/1",
        installation_id: this.installationId,
        owner_id: this.ownerId,
      });
    });
  }
  async transaction<T>(
    work: (tx: CloudflareExecutionTransaction) => Promise<T>,
  ): Promise<T> {
    let refusal: AgentHubError | undefined;
    try {
      return await this.storage.transaction(async (tx) => {
        try {
          const current = genesis.parse(await tx.get("hub/genesis"));
          if (
            current.installation_id !== this.installationId ||
            current.owner_id !== this.ownerId
          )
            throw new AgentHubError("AGENT_AUTH", 403);
          return await work(tx);
        } catch (e) {
          if (e instanceof AgentHubError) refusal = e;
          throw e;
        }
      });
    } catch (e) {
      if (refusal) throw refusal;
      if (e instanceof AgentHubError) throw e;
      throw new AgentHubError("AGENT_STATE_UNAVAILABLE", 503);
    }
  }
  async initialized() {
    try {
      if (!(await readdir(this.directory)).length) return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new AgentHubError("AGENT_STATE_UNAVAILABLE", 503);
    }
    await this.transaction(async () => {});
    return true;
  }
}
export async function read<T>(
  tx: CloudflareExecutionTransaction,
  id: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const value = await tx.get(id);
  if (value === undefined) throw new AgentHubError("AGENT_NOT_FOUND", 404);
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AgentHubError("AGENT_STATE_UNAVAILABLE", 503);
  return parsed.data;
}
export async function list<T>(
  tx: CloudflareExecutionTransaction,
  prefix: string,
  schema: z.ZodType<T>,
  limit = 256,
) {
  const values = await tx.list({ prefix, limit: limit + 1 });
  if (values.size > limit) throw new AgentHubError("AGENT_LIMIT", 413);
  return [...values.values()].map((v) => {
    const r = schema.safeParse(v);
    if (!r.success) throw new AgentHubError("AGENT_STATE_UNAVAILABLE", 503);
    return r.data;
  });
}
