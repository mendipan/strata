import path from "node:path";
import { request } from "node:http";
import { studioAgentHubFixture } from "./studio-agent-hub-fixture.js";
import { managerHostFixture } from "./studio-manager-host-fixture.js";
import { OwnerAccess } from "../src/explorer/owner-access.js";
import { startExplorer } from "../src/explorer/host.js";
import { ExplorerReader } from "../src/explorer/read.js";
import { TestSource, sample } from "./explorer-fixture.js";
import { StudioAgentHttp } from "../src/studio-agents/http.js";
import { AgentHubState } from "../src/studio-agents/state.js";
import { AgentVault } from "../src/studio-agents/vault.js";
import { StudioAgentHub } from "../src/studio-agents/hub.js";
export async function studioAgentHttpFixture(now = Date.now) {
  const base = await managerHostFixture();
  await base.server.close();
  const f = await studioAgentHubFixture(),
    active = (await base.bootstrapState.owner())!;
  const state = new AgentHubState(
      path.join(f.directory, "http-hub"),
      active.manifest.installation_id,
      active.owner_id,
      { assertWindowsCustody: async () => {} },
    ),
    vault = new AgentVault(
      path.join(f.directory, "http-hub", "vault"),
      path.join(f.directory, "http-hub", "key.bin"),
    );
  const hub = new StudioAgentHub(state, vault, {
    async start() {},
    async inspect() {
      return {};
    },
    async cancel() {},
  });
  const owner = new OwnerAccess(
    base.bootstrapState,
    { publicOrigin: base.origin, trustedProxyAddresses: ["127.0.0.1"] },
    now,
    { invalidated: () => hub.changed() },
  );
  const http = new StudioAgentHttp(
    hub,
    owner,
    async () => f.project,
    path.resolve("dist/studio-agent-runner.zip"),
  );
  const reader = new ExplorerReader(new TestSource(await sample()));
  await reader.refresh();
  const server = await startExplorer(reader, {
    assets: path.resolve("explorer"),
    owner,
    agentHttp: http,
  });
  const cookies = new Map<string, string>();
  const send = (
    route: string,
    method = "GET",
    input?: unknown,
    csrf?: string,
    extra: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; data: any; text: string }>(
      (resolve, reject) => {
        const req = request(
          server.origin + route,
          {
            method,
            headers: {
              host: "studio.example.test",
              "x-forwarded-proto": "https",
              ...(method === "POST"
                ? { origin: base.origin, "content-type": "application/json" }
                : {}),
              cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
              ...(csrf ? { "x-studio-csrf": csrf } : {}),
              ...extra,
            },
          },
          (res) => {
            for (const raw of res.headers["set-cookie"] ?? []) {
              const pair = raw.split(";")[0],
                i = pair.indexOf("=");
              cookies.set(pair.slice(0, i), pair.slice(i + 1));
            }
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (text += c));
            res.on("end", () => {
              let data;
              try {
                data = JSON.parse(text);
              } catch {}
              resolve({ status: res.statusCode!, data, text });
            });
          },
        );
        req.on("error", reject);
        req.end(input === undefined ? undefined : JSON.stringify(input));
      },
    );
  const login = async () => {
    const p = await send("/studio/owner/session");
    const r = await send(
      "/studio/owner/login",
      "POST",
      { username: "manager.owner", password: base.password },
      p.data.csrf,
    );
    if (r.status !== 200) throw Error("Synthetic owner login failed");
    return r.data;
  };
  return {
    ...f,
    server,
    owner,
    hub,
    origin: base.origin,
    password: base.password,
    send,
    login,
  };
}
