/** Synthetic projections, cross-checked with generated 0.162.1 experimental schemas.
 * Source: 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d,
 * app-server-protocol/src/protocol/v2/{thread,turn}.rs.
 */
export function codexThreadReply(params: any, id = "original-thread") {
  return {
    thread: { id }, model: params.model, cwd: params.cwd, approvalPolicy: "never",
    runtimeWorkspaceRoots: [...params.runtimeWorkspaceRoots],
    activePermissionProfile: { id: params.permissions, extends: null },
  };
}
export function codexExperimentalSchemas(): Record<string, any> {
  const params = () => ({
    definitions: { AbsolutePathBuf: { type: "string" } },
    properties: {
      permissions: { type: ["string", "null"] },
      runtimeWorkspaceRoots: { type: ["array", "null"], items: { $ref: "#/definitions/AbsolutePathBuf" } },
    },
  });
  return {
    ThreadStartParams: params(), TurnStartParams: params(),
    ThreadStartResponse: {
      definitions: { ActivePermissionProfile: { type: "object", properties: {
        id: { type: "string" }, extends: { type: ["string", "null"] },
      } } },
      properties: { activePermissionProfile: { anyOf: [{ $ref: "#/definitions/ActivePermissionProfile" }, { type: "null" }] },
        runtimeWorkspaceRoots: { type: "array", items: { type: "string" } },
      },
    },
  };
}
