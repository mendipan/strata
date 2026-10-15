import path from "node:path";
import { z } from "zod";
import { AgentHubState } from "./state.js";
import { AgentVault } from "./vault.js";
import type { AgentContext } from "./protocol.js";
import { StudioAgentHub } from "./hub.js";
import {
  CloudflareChatRuntime,
  CloudflareAgentProvisioner,
} from "./cloudflare.js";
import { canonicalDisjointPaths } from "../explorer/workspace-policy.js";
import { assertAgentWindowsCustody } from "./windows-custody.js";

const absolute = z
  .string()
  .max(4096)
  .refine((p) => path.isAbsolute(p) && path.resolve(p) === p);
export const studioAgentsHostSchema = z
  .object({
    format: z.literal("strata-studio-agent-host/1"),
    directory: absolute,
    bundle_file: absolute,
  })
  .strict();
export type StudioAgentsHostConfig = z.infer<typeof studioAgentsHostSchema>;
export function createStudioAgentHub(
  configuration: StudioAgentsHostConfig,
  installationId: string,
  ownerId: string,
  protectedPaths: string[],
  transport: typeof fetch = fetch,
  dispatchFence?: (
    context: AgentContext,
    ownerGeneration: number,
  ) => Promise<void>,
) {
  const config = studioAgentsHostSchema.parse(configuration);
  canonicalDisjointPaths([
    config.directory,
    config.bundle_file,
    ...protectedPaths,
  ]);
  const state = new AgentHubState(config.directory, installationId, ownerId, {
    assertWindowsCustody: assertAgentWindowsCustody,
  });
  const custody =
    process.platform === "win32"
      ? () => assertAgentWindowsCustody(config.directory)
      : undefined;
  const vault = new AgentVault(
    path.join(config.directory, "vault"),
    path.join(config.directory, "agent-key.bin"),
    custody,
  );
  return new StudioAgentHub(
    state,
    vault,
    new CloudflareChatRuntime(vault, transport),
    new CloudflareAgentProvisioner(vault, config.bundle_file, transport),
    Date.now,
    dispatchFence,
  );
}
